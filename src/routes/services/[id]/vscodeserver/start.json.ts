import { asyncExecShell, createDirectories, getEngine, getUserDetails } from '$lib/common';
import * as db from '$lib/database';
import { promises as fs } from 'fs';
import yaml from 'js-yaml';
import type { RequestHandler } from '@sveltejs/kit';
import { ErrorHandler, getServiceImage } from '$lib/database';
import { makeLabelForServices } from '$lib/buildPacks/common';
import type { ComposeFile } from '$lib/types/composeFile';

export const post: RequestHandler = async (event) => {
	const { teamId, status, body } = await getUserDetails(event);
	if (status === 401) return { status, body };

	const { id } = event.params;

	try {
		const service = await db.getService({ id, teamId });
		const {
			type,
			version,
			destinationDockerId,
			destinationDocker,
			serviceSecret,
			persistentStorage,
			vscodeserver: { password }
		} = service;

		const network = destinationDockerId && destinationDocker.network;
		const host = getEngine(destinationDocker.engine);

		const { workdir } = await createDirectories({ repository: type, buildId: id });
		const image = getServiceImage(type);

		const config = {
			image: `${image}:${version}`,
			volume: `${id}-vscodeserver-data:/home/coder`,
			environmentVariables: {
				PASSWORD: password
			}
		};
		if (serviceSecret.length > 0) {
			serviceSecret.forEach((secret) => {
				config.environmentVariables[secret.name] = secret.value;
			});
		}

		const volumes =
			persistentStorage?.map((storage) => {
				return `${id}${storage.path.replace(/\//gi, '-')}:${storage.path}`;
			}) || [];

		const composeVolumes = volumes.map((volume) => {
			return {
				[`${volume.split(':')[0]}`]: {
					name: volume.split(':')[0]
				}
			};
		});
		const volumeMounts = Object.assign(
			{},
			{
				[config.volume.split(':')[0]]: {
					name: config.volume.split(':')[0]
				}
			},
			...composeVolumes
		);
		const composeFile: ComposeFile = {
			version: '3.8',
			services: {
				[id]: {
					container_name: id,
					image: config.image,
					environment: config.environmentVariables,
					networks: [network],
					volumes: [config.volume, ...volumes],
					restart: 'always',
					labels: makeLabelForServices('vscodeServer'),
					deploy: {
						restart_policy: {
							condition: 'on-failure',
							delay: '5s',
							max_attempts: 3,
							window: '120s'
						}
					}
				}
			},
			networks: {
				[network]: {
					external: true
				}
			},
			volumes: volumeMounts
		};
		const composeFileDestination = `${workdir}/docker-compose.yaml`;
		await fs.writeFile(composeFileDestination, yaml.dump(composeFile));

		await asyncExecShell(`DOCKER_HOST=${host} docker compose -f ${composeFileDestination} pull`);
		await asyncExecShell(`DOCKER_HOST=${host} docker compose -f ${composeFileDestination} up -d`);

		const changePermissionOn = persistentStorage.map((p) => p.path);
		if (changePermissionOn.length > 0) {
			await asyncExecShell(
				`DOCKER_HOST=${host} docker exec -u root ${id} chown -R 1000:1000 ${changePermissionOn.join(
					' '
				)}`
			);
		}
		return {
			status: 200
		};
	} catch (error) {
		return ErrorHandler(error);
	}
};
