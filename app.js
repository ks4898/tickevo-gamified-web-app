const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize Firebase Admin SDK
const serviceAccount = require('./tickevo-ticket-evolution-firebase-adminsdk-fbsvc-6e628ddddb.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// JWT secret key
const JWT_SECRET = '70724d8d89b3766b4b45cf61838142419d7ab90c7f6556577e94bbb9fa03a1fdad18cf5c8d27bcfe250eac323b5a7de9d9d4d60d68f0d2052b2b96a15b41a15b78697fb61f6810d3b37662bd0e194dd2da4d94de45268c1172ffc4950cc560b123cd9f4d5524995b2922bed0b3eda3389dce26e627b6bd34d80220534f4123a514bbc50ca21ebe66e27bc8b7facf8654eaa97e6c56e1af2d9c972072cd4a0a46431713470b463cfd12c54ee84ae0fb8dc99eb543ea29db38ca7bfd1f821b1919558f5dc8a7a6e9967cbc822dcd5f2c727217dbfe606726741ebd0b1c543ad12b762e9560a4951d0fdcd10c63c76b72efb76c4a26fca66ddadcad9c105748f59e';

// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(403).json({ error: 'No token provided' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Unauthorized' });
    req.userId = decoded.userId;
    next();
  });
};

// Login endpoint
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const userDoc = await db.collection('users').where('username', '==', username).get();
    if (userDoc.empty) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = userDoc.docs[0].data();
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const userId = userDoc.docs[0].id;
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, userId, username: user.username });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Signup endpoint
app.post('/api/signup', async (req, res) => {
  const { username, password } = req.body;
  try {
    const userDoc = await db.collection('users').where('username', '==', username).get();
    if (!userDoc.empty) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await db.collection('users').add({
      username,
      password: hashedPassword,
      exp: 0,
      ticketTokens: 0,
      badges: []
    });
    res.json({ success: true, userId: newUser.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a new ticket
app.post('/api/create-ticket', verifyToken, async (req, res) => {
  const { title, description } = req.body;
  try {
    const userDoc = await db.collection('users').doc(req.userId).get();
    const username = userDoc.data().username;
    const newTicket = await db.collection('tickets').add({
      title,
      description,
      createdBy: username,
      creationDate: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdateDate: admin.firestore.FieldValue.serverTimestamp(),
      stage: 'Unseen',
      priority: 'Normal',
      currentTurn: req.userId
    });
    res.json({ success: true, ticketId: newTicket.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all tickets
app.get('/api/tickets', verifyToken, async (req, res) => {
  try {
    const ticketsSnapshot = await db.collection('tickets').orderBy('creationDate', 'desc').get();
    const tickets = ticketsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    res.json(tickets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get a specific ticket
app.get('/api/tickets/:ticketId', verifyToken, async (req, res) => {
  try {
    const ticketDoc = await db.collection('tickets').doc(req.params.ticketId).get();
    if (!ticketDoc.exists) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    const ticket = {
      id: ticketDoc.id,
      ...ticketDoc.data()
    };
    res.json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get chat messages for a specific ticket
app.get('/api/tickets/:ticketId/messages', verifyToken, async (req, res) => {
  try {
    const messagesSnapshot = await db.collection('tickets').doc(req.params.ticketId).collection('messages')
      .orderBy('timestamp', 'asc')
      .get();
    const messages = messagesSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send a message in a ticket's chat
app.post('/api/tickets/:ticketId/messages', verifyToken, async (req, res) => {
  const { message } = req.body;
  const ticketId = req.params.ticketId;
  try {
    const ticketDoc = await db.collection('tickets').doc(ticketId).get();
    const ticketData = ticketDoc.data();
    if (ticketData.currentTurn !== req.userId) {
      return res.status(403).json({ error: 'Not your turn' });
    }
    const userDoc = await db.collection('users').doc(req.userId).get();
    const username = userDoc.data().username;
    await db.collection('tickets').doc(ticketId).collection('messages').add({
      userId: req.userId,
      username: username,
      message,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    // Update turn
    const usersSnapshot = await db.collection('users').get();
    const userIds = usersSnapshot.docs.map(doc => doc.id);
    const currentIndex = userIds.indexOf(req.userId);
    const nextTurn = userIds[(currentIndex + 1) % userIds.length];
    await db.collection('tickets').doc(ticketId).update({ 
      currentTurn: nextTurn,
      lastUpdateDate: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true, nextTurn });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// add sample data for test
async function addSampleData() {
    const users = [
        { username: 'user1', password: 'password1', exp: 100, ticketTokens: 50 },
        { username: 'user2', password: 'password2', exp: 150, ticketTokens: 75 }
    ];

    const tickets = [
        { stage: 'Unseen', priority: 'Normal', createdBy: 'user1', currentTurn: 'user2' },
        { stage: 'Under Review', priority: 'High', createdBy: 'user2', currentTurn: 'user1' }
    ];

    for (const user of users) {
        const hashedPassword = await bcrypt.hash(user.password, 10);
        await db.collection('users').add({
            ...user,
            password: hashedPassword,
            badges: []
        });
    }

    for (const ticket of tickets) {
        await db.collection('tickets').add({
            ...ticket,
            creationDate: admin.firestore.FieldValue.serverTimestamp(),
            lastUpdateDate: admin.firestore.FieldValue.serverTimestamp()
        });
    }

    console.log('Sample data added successfully');
}

//addSampleData(); // call function to add sample data

// start server
app.listen(port, () => {
    console.log(`TickEvo server running on port ${port}`);
});