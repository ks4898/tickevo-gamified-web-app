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
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

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

// Create a new ticket
app.post('/api/create-ticket', verifyToken, async (req, res) => {
  const { title, description, priority } = req.body;
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
      priority: priority || 'Normal',
      currentTurn: null
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

// Update ticket stage
app.put('/api/tickets/:ticketId/stage', verifyToken, async (req, res) => {
  const { stage } = req.body;
  try {
    await db.collection('tickets').doc(req.params.ticketId).update({
      stage,
      lastUpdateDate: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
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
    
    if (ticketData.currentTurn && ticketData.currentTurn !== req.userId) {
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

    let stageUpdated = false;
    if (ticketData.stage === 'Pending Review' && ticketData.createdBy !== username) {
      await db.collection('tickets').doc(ticketId).update({
        stage: 'Under Review',
        lastUpdateDate: admin.firestore.FieldValue.serverTimestamp()
      });
      stageUpdated = true;
    }

    // Update turn
    const nextTurn = null; // Reset turn after each message
    await db.collection('tickets').doc(ticketId).update({ 
      currentTurn: nextTurn,
      lastUpdateDate: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, nextTurn, stageUpdated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add a user to the turn queue
app.post('/api/tickets/:ticketId/queue', verifyToken, async (req, res) => {
  const ticketId = req.params.ticketId;
  try {
    const ticketRef = db.collection('tickets').doc(ticketId);
    await db.runTransaction(async (transaction) => {
      const ticketDoc = await transaction.get(ticketRef);
      if (!ticketDoc.exists) {
        throw new Error('Ticket not found');
      }
      const ticketData = ticketDoc.data();
      let queue = ticketData.queue || [];
      if (!queue.includes(req.userId)) {
        queue.push(req.userId);
        transaction.update(ticketRef, { queue });
      }
      if (!ticketData.currentTurn) {
        transaction.update(ticketRef, { currentTurn: queue[0] });
      }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get the current turn for a ticket
app.get('/api/tickets/:ticketId/turn', verifyToken, async (req, res) => {
  const ticketId = req.params.ticketId;
  try {
    const ticketDoc = await db.collection('tickets').doc(ticketId).get();
    if (!ticketDoc.exists) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    const ticketData = ticketDoc.data();
    res.json({ currentTurn: ticketData.currentTurn, queue: ticketData.queue || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// add sample data for test
async function addSampleData() {
  try {
    // Add sample users
    const users = [
      { username: 'user1', password: await bcrypt.hash('password1', 10), exp: 100, ticketTokens: 50, badges: ['Helper'] },
      { username: 'user2', password: await bcrypt.hash('password2', 10), exp: 150, ticketTokens: 75, badges: ['Helper', 'Lurker'] },
      { username: 'user3', password: await bcrypt.hash('password3', 10), exp: 200, ticketTokens: 100, badges: ['Helper', 'Analyst'] }
    ];

    for (const user of users) {
      await db.collection('users').add(user);
    }

    // Add sample tickets
    const tickets = [
      { title: 'Bug in login page', description: 'Users unable to log in', createdBy: 'user1', creationDate: admin.firestore.FieldValue.serverTimestamp(), lastUpdateDate: admin.firestore.FieldValue.serverTimestamp(), stage: 'Unseen', priority: 'Normal', currentTurn: 'user2' },
      { title: 'Feature request: Dark mode', description: 'Implement dark mode for better user experience', createdBy: 'user2', creationDate: admin.firestore.FieldValue.serverTimestamp(), lastUpdateDate: admin.firestore.FieldValue.serverTimestamp(), stage: 'Pending Review', priority: 'High', currentTurn: 'user3' },
      { title: 'Performance optimization needed', description: 'App is slow on older devices', createdBy: 'user3', creationDate: admin.firestore.FieldValue.serverTimestamp(), lastUpdateDate: admin.firestore.FieldValue.serverTimestamp(), stage: 'Under Review', priority: 'Normal', currentTurn: 'user1' }
    ];

    for (const ticket of tickets) {
      const ticketRef = await db.collection('tickets').add(ticket);
      
      // Add sample messages for each ticket
      const messages = [
        { userId: 'user1', username: 'user1', message: 'I can reproduce this issue', timestamp: admin.firestore.FieldValue.serverTimestamp() },
        { userId: 'user2', username: 'user2', message: 'Let me take a look at it', timestamp: admin.firestore.FieldValue.serverTimestamp() },
        { userId: 'user3', username: 'user3', message: 'I think I found the problem', timestamp: admin.firestore.FieldValue.serverTimestamp() }
      ];

      for (const message of messages) {
        await db.collection('tickets').doc(ticketRef.id).collection('messages').add(message);
      }
    }

    console.log('Sample data added successfully');
  } catch (error) {
    console.error('Error adding sample data:', error);
  }
}

//addSampleData(); // call function to add sample data

// start server
app.listen(port, () => {
    console.log(`TickEvo server running on port ${port}`);
});