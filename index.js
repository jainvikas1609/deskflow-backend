require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const app     = express();

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

app.use('/auth',      require('./routes/auth'));
app.use('/tickets',   require('./routes/tickets'));
app.use('/users',     require('./routes/users'));
app.use('/customers', require('./routes/customers'));
app.use('/sla',       require('./routes/sla'));
app.use('/kb',        require('./routes/kb'));
app.use('/admin',     require('./routes/admin'));
app.use('/reports',   require('./routes/reports'));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`EkivaCare API running on port ${PORT}`));
