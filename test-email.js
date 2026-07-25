import 'dotenv/config';
import { verifyEmailTransport } from './src/services/email.service.js';

try {
  await verifyEmailTransport();

  console.log('SMTP connection and authentication succeeded.');
  process.exit(0);
} catch (error) {
  console.error('SMTP verification failed:', error);
  process.exit(1);
}
