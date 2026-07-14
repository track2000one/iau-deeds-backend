import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'IAU Deeds and Lands API',
    time: new Date().toISOString(),
  });
});

export default router;
