require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

app.use('/auth',    require('./routes/auth'));
app.use('/tickets', require('./routes/tickets'));
app.use('/users',   require('./routes/users'));

// Railway uses this endpoint to confirm the app started successfully
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`DeskFlow API running on port ${PORT}`));
