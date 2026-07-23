import 'dotenv/config';
import { app } from './app.js';
import { ensureBootstrapAdmin } from './bootstrapAdmin.js';

const port = Number(process.env.PORT || 8080);

const startServer = async () => {
  await ensureBootstrapAdmin();

  app.listen(port, () => {
    console.log(`IAU Deeds and Lands API is running on port ${port}`);
  });
};

startServer().catch((error) => {
  console.error('Unable to start the API:', error);
  process.exit(1);
});
