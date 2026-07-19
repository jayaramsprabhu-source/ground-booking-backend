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

// ===== TEAMS =====

app.get('/api/teams', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM teams ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

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

// ===== BOOKINGS =====

// GET all bookings (with team name joined in, so frontend doesn't need a second lookup)
app.get('/api/bookings', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, t.name AS team_name, t.captain_name, t.mobile
      FROM bookings b
      LEFT JOIN teams t ON b.team_id = t.id
      ORDER BY b.date DESC, b.time_slot ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// GET a single booking by id
app.get('/api/bookings/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, t.name AS team_name, t.captain_name, t.mobile
      FROM bookings b
      LEFT JOIN teams t ON b.team_id = t.id
      WHERE b.id = $1
    `, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// ADD a new booking
app.post('/api/bookings', async (req, res) => {
  const { team_id, date, time_slot, format, ground, total_fee, advance_paid, status, remarks } = req.body;
  const balance = (parseFloat(total_fee) || 0) - (parseFloat(advance_paid) || 0);
  try {
    const result = await pool.query(
      `INSERT INTO bookings (team_id, date, time_slot, format, ground, total_fee, advance_paid, balance, status, remarks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [team_id, date, time_slot, format, ground, total_fee, advance_paid, balance, status || 'Booked', remarks]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add booking' });
  }
});

// UPDATE an existing booking
app.put('/api/bookings/:id', async (req, res) => {
  const { team_id, date, time_slot, format, ground, total_fee, advance_paid, status, remarks } = req.body;
  const balance = (parseFloat(total_fee) || 0) - (parseFloat(advance_paid) || 0);
  try {
    const result = await pool.query(
      `UPDATE bookings SET team_id=$1, date=$2, time_slot=$3, format=$4, ground=$5,
       total_fee=$6, advance_paid=$7, balance=$8, status=$9, remarks=$10
       WHERE id=$11 RETURNING *`,
      [team_id, date, time_slot, format, ground, total_fee, advance_paid, balance, status, remarks, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

// DELETE a booking
app.delete('/api/bookings/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM bookings WHERE id=$1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    res.json({ message: 'Booking deleted', booking: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete booking' });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
