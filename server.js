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

// Recalculate a booking's advance_paid, balance, and status from its payments
async function recomputeBooking(bookingId) {
  const sumResult = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE booking_id = $1',
    [bookingId]
  );
  const totalPaid = parseFloat(sumResult.rows[0].total_paid);

  const bookingResult = await pool.query(
    'SELECT total_fee, is_overridden, status FROM bookings WHERE id = $1',
    [bookingId]
  );
  if (bookingResult.rows.length === 0) return;
  const { total_fee, is_overridden, status: currentStatus } = bookingResult.rows[0];
  const totalFee = parseFloat(total_fee) || 0;
  const balance = totalFee - totalPaid;

  if (currentStatus === 'Cancelled') {
    await pool.query('UPDATE bookings SET advance_paid=$1, balance=$2 WHERE id=$3', [totalPaid, balance, bookingId]);
    return;
  }

  let status;
  if (totalPaid <= 0) {
    status = is_overridden ? 'Booked' : 'Pending';
  } else if (balance > 0) {
    status = 'Advance Paid';
  } else {
    status = 'Paid';
  }

  await pool.query(
    'UPDATE bookings SET advance_paid = $1, balance = $2, status = $3 WHERE id = $4',
    [totalPaid, balance, status, bookingId]
  );
}

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

app.get('/api/bookings', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, t.name AS team_name, t.captain_name, t.mobile
      FROM bookings b
      LEFT JOIN teams t ON b.team_id = t.id
      ORDER BY b.date DESC, b.start_time ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

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

// ADD a new booking — always starts as Pending, no payment/status taken here
app.post('/api/bookings', async (req, res) => {
  const { team_id, date, start_time, end_time, format, ground, total_fee, remarks } = req.body;
  const time_slot = `${start_time} - ${end_time}`;
  try {
    const conflict = await pool.query(
      `SELECT b.*, t.name AS team_name FROM bookings b
       LEFT JOIN teams t ON b.team_id = t.id
       WHERE b.date = $1 AND b.status != 'Cancelled'
       AND b.start_time < $3 AND b.end_time > $2`,
      [date, start_time, end_time]
    );
    if (conflict.rows.length > 0) {
      return res.status(409).json({
        error: 'Time overlaps with an existing booking',
        existing: conflict.rows[0]
      });
    }

    const result = await pool.query(
      `INSERT INTO bookings (team_id, date, start_time, end_time, time_slot, format, ground, total_fee, advance_paid, balance, status, remarks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $8, 'Pending', $9) RETURNING *`,
      [team_id, date, start_time, end_time, time_slot, format, ground, total_fee, remarks]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add booking' });
  }
});

app.put('/api/bookings/:id', async (req, res) => {
  const { team_id, date, start_time, end_time, format, ground, total_fee, remarks } = req.body;
  const time_slot = `${start_time} - ${end_time}`;
  try {
    const conflict = await pool.query(
      `SELECT b.*, t.name AS team_name FROM bookings b
       LEFT JOIN teams t ON b.team_id = t.id
       WHERE b.date = $1 AND b.status != 'Cancelled' AND b.id != $4
       AND b.start_time < $3 AND b.end_time > $2`,
      [date, start_time, end_time, req.params.id]
    );
    if (conflict.rows.length > 0) {
      return res.status(409).json({
        error: 'Time overlaps with an existing booking',
        existing: conflict.rows[0]
      });
    }

    const result = await pool.query(
      `UPDATE bookings SET team_id=$1, date=$2, start_time=$3, end_time=$4, time_slot=$5, format=$6, ground=$7,
       total_fee=$8, remarks=$9
       WHERE id=$10 RETURNING *`,
      [team_id, date, start_time, end_time, time_slot, format, ground, total_fee, remarks, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    await recomputeBooking(req.params.id);
    const updated = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
    res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

// OVERRIDE — admin confirms a Pending booking without payment, note required
app.put('/api/bookings/:id/override', async (req, res) => {
  const { note, by } = req.body;
  if (!note || !note.trim()) {
    return res.status(400).json({ error: 'A note is required to override' });
  }
  try {
    const result = await pool.query(
      `UPDATE bookings SET is_overridden = true, override_note = $1, override_by = $2, override_at = NOW()
       WHERE id = $3 AND status = 'Pending' RETURNING *`,
      [note, by || 'Admin', req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Booking is not in Pending status, cannot override' });
    }
    await recomputeBooking(req.params.id);
    const updated = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
    res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to override booking' });
  }
});

// CANCEL — admin cancels a Pending or Confirmed booking, frees the slot
app.put('/api/bookings/:id/cancel', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE bookings SET status = 'Cancelled' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to cancel booking' });
  }
});

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

// ===== PAYMENTS =====

app.get('/api/payments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, b.date AS booking_date, b.total_fee, t.name AS team_name
      FROM payments p
      LEFT JOIN bookings b ON p.booking_id = b.id
      LEFT JOIN teams t ON b.team_id = t.id
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

app.get('/api/payments/booking/:bookingId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at DESC',
      [req.params.bookingId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

app.post('/api/payments', async (req, res) => {
  const { booking_id, amount, payment_method, transaction_ref, received_by, notes } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO payments (booking_id, amount, payment_method, transaction_ref, received_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [booking_id, amount, payment_method, transaction_ref, received_by, notes]
    );
    await recomputeBooking(booking_id);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add payment' });
  }
});

app.delete('/api/payments/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM payments WHERE id=$1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Payment not found' });
    await recomputeBooking(result.rows[0].booking_id);
    res.json({ message: 'Payment deleted', payment: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete payment' });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
