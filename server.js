const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Ground Booking API is running');
});

// GET all teams
app.get('/api/teams', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM teams ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

// GET a single team by id
app.get('/api/teams/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM teams WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Team not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

// ADD a new team
app.post('/api/teams', async (req, res) => {
  const { name, captain_name, mobile, alt_mobile, city, fav_format, fav_ball, notes } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO teams (name, captain_name, mobile, alt_mobile, city, fav_format, fav_ball, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, captain_name, mobile, alt_mobile, city, fav_format, fav_ball, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add team' });
  }
});

// UPDATE an existing team
app.put('/api/teams/:id', async (req, res) => {
  const { name, captain_name, mobile, alt_mobile, city, fav_format, fav_ball, notes } = req.body;
  try {
    const result = await pool.query(
      `UPDATE teams SET name=$1, captain_name=$2, mobile=$3, alt_mobile=$4, city=$5, fav_format=$6, fav_ball=$7, notes=$8
       WHERE id=$9 RETURNING *`,
      [name, captain_name, mobile, alt_mobile, city, fav_format, fav_ball, notes, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Team not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update team' });
  }
});

// DELETE a team
app.delete('/api/teams/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM teams WHERE id=$1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Team not found' });
    res.json({ message: 'Team deleted', team: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete team' });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
