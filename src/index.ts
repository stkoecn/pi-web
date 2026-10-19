import { PiWebGatewayApp } from './server/app';

async function main() {
  const httpPort = Number(process.env.HTTP_PORT || process.env.PORT || 9564);
  const httpHost = process.env.HTTP_HOST || process.env.HOST || '127.0.0.1';
  const sshPort = Number(process.env.SSH_PORT || 22222);
  const sshHost = process.env.SSH_HOST || '0.0.0.0';

  console.log(`Starting Pi Web Gateway (Device Tunnel Hub)...`);

  const app = new PiWebGatewayApp({
    httpPort,
    httpHost,
    sshPort,
    sshHost,
  });

  const { httpPort: actualHttpPort, sshPort: actualSshPort } = await app.start();

  console.log(`=======================================================`);
  console.log(`⚡ Pi Web Gateway is running!`);
  console.log(`🌐 Web Dashboard / API:   http://${httpHost}:${actualHttpPort}`);
  console.log(`🔒 SSH Reverse Tunnel Hub: ssh://${sshHost}:${actualSshPort}`);
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
