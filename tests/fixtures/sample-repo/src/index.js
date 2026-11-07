/**
 * Sample Express service (fixture).
 * @author Jane Doe <jane@acme.example>
 * Copyright (c) 2021-2024 Acme Corporation
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import { findUser, runQuery } from './db.js';

const app = express();
const SECRET = 'sk_live_FIXTURE_NOT_A_REAL_SECRET_1234567890';

app.get('/users/:id', async (req, res) => {
  // Intentionally vulnerable for the fixture: string-concatenated SQL.
  const rows = await runQuery("SELECT * FROM users WHERE id = '" + req.params.id + "'");
  res.json(rows);
});

app.post('/login', async (req, res) => {
  const user = await findUser(req.body.email);
  if (user && user.password === req.body.password) {
    res.json({ token: jwt.sign({ id: user.id }, SECRET) });
  } else {
    res.status(401).send('nope');
  }
});

app.listen(3000);
