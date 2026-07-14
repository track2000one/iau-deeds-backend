import 'dotenv/config';
import { app } from './app.js';

const port = Number(process.env.PORT || 8080);

app.listen(port, () => {
  console.log(`IAU Deeds and Lands API is running on port ${port}`);
});
