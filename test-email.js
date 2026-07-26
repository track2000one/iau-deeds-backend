import "dotenv/config";
import {
  verifyEmailTransport,
} from "./src/services/email.service.js";

try {
  await verifyEmailTransport();

  console.log("Brevo email API configuration succeeded.");
} catch (error) {
  console.error(
    "Brevo email API verification failed:",
    error
  );

  process.exitCode = 1;
}