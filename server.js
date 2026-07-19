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

// ===== TOURNAMENTS =====

app.get('/api/tournaments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*,
        (SELECT COUNT(*) FROM tournament_teams tt WHERE tt.tournament_id = t.id) AS registered_teams,
        (SELECT COUNT(*) FROM matches m WHERE m.tournament_id = t.id) AS total_matches
      FROM tournaments t
      ORDER BY t.start_date DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tournaments' });
  }
});

app.get('/api/tournaments/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tournaments WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tournament not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tournament' });
  }
});

app.post('/api/tournaments', async (req, res) => {
  const { name, total_teams, start_date, status, prize_money } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO tournaments (name, total_teams, start_date, status, prize_money)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, total_teams, start_date, status || 'Upcoming', prize_money]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add tournament' });
  }
});

app.put('/api/tournaments/:id', async (req, res) => {
  const { name, total_teams, start_date, status, prize_money } = req.body;
  try {
    const result = await pool.query(
      `UPDATE tournaments SET name=$1, total_teams=$2, start_date=$3, status=$4, prize_money=$5
       WHERE id=$6 RETURNING *`,
      [name, total_teams, start_date, status, prize_money, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tournament not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update tournament' });
  }
});

app.delete('/api/tournaments/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM matches WHERE tournament_id = $1', [req.params.id]);
    await pool.query('DELETE FROM tournament_teams WHERE tournament_id = $1', [req.params.id]);
    const result = await pool.query('DELETE FROM tournaments WHERE id=$1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tournament not found' });
    res.json({ message: 'Tournament deleted', tournament: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete tournament' });
  }
});

app.get('/api/tournaments/:id/teams', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT tt.id AS registration_id, t.*
      FROM tournament_teams tt
      JOIN teams t ON tt.team_id = t.id
      WHERE tt.tournament_id = $1
      ORDER BY t.name ASC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tournament teams' });
  }
});

app.post('/api/tournaments/:id/teams', async (req, res) => {
  const { team_id } = req.body;
  try {
    const existing = await pool.query(
      'SELECT * FROM tournament_teams WHERE tournament_id = $1 AND team_id = $2',
      [req.params.id, team_id]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Team already registered in this tournament' });
    }
    const result = await pool.query(
      'INSERT INTO tournament_teams (tournament_id, team_id) VALUES ($1, $2) RETURNING *',
      [req.params.id, team_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to register team' });
  }
});

app.delete('/api/tournaments/:tournamentId/teams/:teamId', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM tournament_teams WHERE tournament_id = $1 AND team_id = $2 RETURNING *',
      [req.params.tournamentId, req.params.teamId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Registration not found' });
    res.json({ message: 'Team removed from tournament' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove team' });
  }
});

app.get('/api/tournaments/:id/matches', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, ta.name AS team_a_name, tb.name AS team_b_name, tw.name AS winner_name
      FROM matches m
      LEFT JOIN teams ta ON m.team_a_id = ta.id
      LEFT JOIN teams tb ON m.team_b_id = tb.id
      LEFT JOIN teams tw ON m.winner_team_id = tw.id
      WHERE m.tournament_id = $1
      ORDER BY m.match_date ASC, m.start_time ASC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

app.post('/api/tournaments/:id/matches/bulk', async (req, res) => {
  const { matches } = req.body;
  if (!Array.isArray(matches) || matches.length === 0) {
    return res.status(400).json({ error: 'No matches provided' });
  }
  const created = [];
  const errors = [];
  for (let i = 0; i < matches.length; i++) {
    const { team_a_id, team_b_id, match_date, start_time, end_time, stage } = matches[i];
    if (!team_a_id || !team_b_id) {
      errors.push({ row: i + 1, error: 'Missing team A or team B' });
      continue;
    }
    try {
      const result = await pool.query(
        `INSERT INTO matches (tournament_id, team_a_id, team_b_id, match_date, start_time, end_time, stage, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'Not Played') RETURNING *`,
        [req.params.id, team_a_id, team_b_id, match_date || null, start_time || null, end_time || null, stage || 'League']
      );
      created.push(result.rows[0]);
    } catch (err) {
      errors.push({ row: i + 1, error: 'Failed to insert' });
    }
  }
  res.status(201).json({ created: created.length, errors });
});

app.post('/api/tournaments/:id/matches', async (req, res) => {
  const { team_a_id, team_b_id, match_date, start_time, end_time, stage } = req.body;
  try {
    if (match_date && start_time && end_time) {
      const bookingConflict = await pool.query(
        `SELECT b.*, t.name AS team_name FROM bookings b
         LEFT JOIN teams t ON b.team_id = t.id
         WHERE b.date = $1 AND b.status != 'Cancelled'
         AND b.start_time < $3 AND b.end_time > $2`,
        [match_date, start_time, end_time]
      );
      if (bookingConflict.rows.length > 0) {
        return res.status(409).json({
          error: 'This time overlaps with an existing ground booking',
          existing: bookingConflict.rows[0],
          conflictType: 'booking'
        });
      }

      const matchConflict = await pool.query(
        `SELECT m.*, ta.name AS team_a_name, tb.name AS team_b_name FROM matches m
         LEFT JOIN teams ta ON m.team_a_id = ta.id
         LEFT JOIN teams tb ON m.team_b_id = tb.id
         WHERE m.match_date = $1
         AND m.start_time < $3 AND m.end_time > $2`,
        [match_date, start_time, end_time]
      );
      if (matchConflict.rows.length > 0) {
        return res.status(409).json({
          error: 'This time overlaps with another fixture',
          existing: matchConflict.rows[0],
          conflictType: 'fixture'
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO matches (tournament_id, team_a_id, team_b_id, match_date, start_time, end_time, stage, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Not Played') RETURNING *`,
      [req.params.id, team_a_id, team_b_id, match_date || null, start_time || null, end_time || null, stage || 'League']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add match' });
  }
});

app.put('/api/matches/:id', async (req, res) => {
  const { team_a_id, team_b_id, match_date, start_time, end_time, stage, result: resultText, outcome, winner_team_id } = req.body;
  try {
    if (match_date && start_time && end_time) {
      const bookingConflict = await pool.query(
        `SELECT b.*, t.name AS team_name FROM bookings b
         LEFT JOIN teams t ON b.team_id = t.id
         WHERE b.date = $1 AND b.status != 'Cancelled'
         AND b.start_time < $3 AND b.end_time > $2`,
        [match_date, start_time, end_time]
      );
      if (bookingConflict.rows.length > 0) {
        return res.status(409).json({
          error: 'This time overlaps with an existing ground booking',
          existing: bookingConflict.rows[0],
          conflictType: 'booking'
        });
      }

      const matchConflict = await pool.query(
        `SELECT m.*, ta.name AS team_a_name, tb.name AS team_b_name FROM matches m
         LEFT JOIN teams ta ON m.team_a_id = ta.id
         LEFT JOIN teams tb ON m.team_b_id = tb.id
         WHERE m.match_date = $1 AND m.id != $4
         AND m.start_time < $3 AND m.end_time > $2`,
        [match_date, start_time, end_time, req.params.id]
      );
      if (matchConflict.rows.length > 0) {
        return res.status(409).json({
          error: 'This time overlaps with another fixture',
          existing: matchConflict.rows[0],
          conflictType: 'fixture'
        });
      }
    }

    const result = await pool.query(
      `UPDATE matches SET team_a_id=$1, team_b_id=$2, match_date=$3, start_time=$4, end_time=$5, stage=$6, result=$7, outcome=$8, winner_team_id=$9
       WHERE id=$10 RETURNING *`,
      [team_a_id, team_b_id, match_date, start_time, end_time, stage, resultText, outcome, winner_team_id || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Match not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update match' });
  }
});

app.delete('/api/matches/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM matches WHERE id=$1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Match not found' });
    res.json({ message: 'Match deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete match' });
  }
});

app.get('/api/tournaments/:id/standings', async (req, res) => {
  try {
    const teamsResult = await pool.query(`
      SELECT t.id, t.name
      FROM tournament_teams tt
      JOIN teams t ON tt.team_id = t.id
      WHERE tt.tournament_id = $1
    `, [req.params.id]);

    const matchesResult = await pool.query(
      `SELECT * FROM matches WHERE tournament_id = $1 AND outcome != 'Not Played'`,
      [req.params.id]
    );

    const standings = {};
    teamsResult.rows.forEach((t) => {
      standings[t.id] = {
        team_id: t.id,
        team_name: t.name,
        played: 0, won: 0, lost: 0, tied: 0, points: 0
      };
    });

    matchesResult.rows.forEach((m) => {
      const a = standings[m.team_a_id];
      const b = standings[m.team_b_id];
      if (!a || !b) return;

      a.played += 1;
      b.played += 1;

      if (m.outcome === 'Team A Won') {
        a.won += 1; a.points += 2;
        b.lost += 1;
      } else if (m.outcome === 'Team B Won') {
        b.won += 1; b.points += 2;
        a.lost += 1;
      } else if (m.outcome === 'Tie' || m.outcome === 'No Result') {
        a.tied += 1; a.points += 1;
        b.tied += 1; b.points += 1;
      }
    });

    const table = Object.values(standings).sort((x, y) => y.points - x.points || y.won - x.won);
    res.json(table);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute standings' });
  }
});

// ===== UMPIRES =====

app.get('/api/umpires', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM umpires ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch umpires' });
  }
});

app.post('/api/umpires', async (req, res) => {
  const { name, mobile, preferred_formats } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO umpires (name, mobile, preferred_formats) VALUES ($1, $2, $3) RETURNING *',
      [name, mobile, preferred_formats]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add umpire' });
  }
});

app.put('/api/umpires/:id', async (req, res) => {
  const { name, mobile, preferred_formats } = req.body;
  try {
    const result = await pool.query(
      'UPDATE umpires SET name=$1, mobile=$2, preferred_formats=$3 WHERE id=$4 RETURNING *',
      [name, mobile, preferred_formats, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Umpire not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update umpire' });
  }
});

app.delete('/api/umpires/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM umpires WHERE id=$1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Umpire not found' });
    res.json({ message: 'Umpire deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete umpire' });
  }
});

// ===== INVENTORY =====

app.get('/api/inventory', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM inventory ORDER BY item_type ASC, name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

app.post('/api/inventory', async (req, res) => {
  const { item_type, name, quantity, reorder_level, last_order_date } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO inventory (item_type, name, quantity, reorder_level, last_order_date)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [item_type, name, quantity || 0, reorder_level || 5, last_order_date || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add inventory item' });
  }
});

app.put('/api/inventory/:id', async (req, res) => {
  const { item_type, name, quantity, reorder_level, last_order_date } = req.body;
  try {
    const result = await pool.query(
      `UPDATE inventory SET item_type=$1, name=$2, quantity=$3, reorder_level=$4, last_order_date=$5
       WHERE id=$6 RETURNING *`,
      [item_type, name, quantity, reorder_level, last_order_date || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update inventory item' });
  }
});

app.delete('/api/inventory/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM inventory WHERE id=$1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ message: 'Item deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// ===== EXPENSES =====

app.get('/api/expenses', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM expenses ORDER BY date DESC, created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

app.post('/api/expenses', async (req, res) => {
  const { category, description, amount, date, paid_by_name } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO expenses (category, description, amount, date, paid_by_name)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [category, description, amount, date, paid_by_name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add expense' });
  }
});

app.put('/api/expenses/:id', async (req, res) => {
  const { category, description, amount, date, paid_by_name } = req.body;
  try {
    const result = await pool.query(
      `UPDATE expenses SET category=$1, description=$2, amount=$3, date=$4, paid_by_name=$5
       WHERE id=$6 RETURNING *`,
      [category, description, amount, date, paid_by_name, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Expense not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update expense' });
  }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM expenses WHERE id=$1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Expense not found' });
    res.json({ message: 'Expense deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete expense' });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
