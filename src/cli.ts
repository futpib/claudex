#!/usr/bin/env node

import process from 'node:process';

const subcommand = process.argv[2];

switch (subcommand) {
	case 'hook': {
		const hookName = process.argv[3];
		// Remove 'hook' and hook name from argv so the hook sees clean args
		process.argv.splice(2, 2);

		switch (hookName) {
			case 'pre-tool-use': {
				const { main } = await import('./hooks/pre-tool-use.js');
				await main();
				break;
			}

			case 'notification': {
				const { main } = await import('./hooks/notification.js');
				await main();
				break;
			}

			case 'stop': {
				const { main } = await import('./hooks/stop.js');
				await main();
				break;
			}

			case 'user-prompt-submit': {
				const { main } = await import('./hooks/user-prompt-submit.js');
				await main();
				break;
			}

			default: {
				console.error(`Unknown hook: ${hookName}`);
				process.exit(1);
			}
		}

		break;
	}

	case 'in-docker': {
		// Remove 'in-docker' from argv so mainInDocker sees clean args
		process.argv.splice(2, 1);
		const { mainInDocker } = await import('./in-docker.js');
		await mainInDocker();
		break;
	}

	case 'mcp': {
		// Remove 'mcp' from argv so the MCP server sees clean args
		process.argv.splice(2, 1);
		const { startServer } = await import('./mcp/server.js');
		await startServer();
		break;
	}

	default: {
		const { main } = await import('./index.js');
		await main();
		break;
	}
}
