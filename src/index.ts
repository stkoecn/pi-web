import { PiWebGatewayApp } from './server/app';

async function main() {
  const httpPort = Number(process.env.HTTP_PORT || process.env.PORT || 9564);
  const sshPort = Number(process.env.SSH_PORT || 22222);
  const host = process.env.HOST || '0.0.0.0';

  console.log(`Starting Pi Web Gateway (Device Tunnel Hub)...`);

  const app = new PiWebGatewayApp({
    httpPort,
    sshPort,
    host,
  });

  const { httpPort: actualHttpPort, sshPort: actualSshPort } = await app.start();

  console.log(`=======================================================`);
  console.log(`⚡ Pi Web Gateway is running!`);
  console.log(`🌐 Web Dashboard / API:   http://localhost:${actualHttpPort}`);
  console.log(`🔒 SSH Reverse Tunnel Hub: ssh://0.0.0.0:${actualSshPort}`);
  console.log(`💡 Connect reverse device: ssh -NR 0:localhost:22 my-device@<ip> -p ${actualSshPort}`);
  console.log(`=======================================================`);

  const shutdown = async () => {
    console.log('\nShutting down Pi Web Gateway...');
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
