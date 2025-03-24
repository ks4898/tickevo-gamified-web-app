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

    // Add ticket action
    await db.collection('ticketActions').add({
      userId: req.userId,
      ticketId: newTicket.id,
      actionType: 'Create',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      details: 'Ticket created'
    });

    res.json({ success: true, ticketId: newTicket.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all tickets
app.get('/api/tickets', verifyToken, async (req, res) => {
  try {
    const ticketsSnapshot = await db.collection('tickets')
      .orderBy('priority', 'desc')
      .orderBy('creationDate', 'asc')
      .get();
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

    // Update stage if necessary
    if (ticket.stage === 'Unseen' && ticket.createdBy !== req.userId) {
      await db.collection('tickets').doc(req.params.ticketId).update({
        stage: 'Pending Review',
        lastUpdateDate: admin.firestore.FieldValue.serverTimestamp()
      });
      ticket.stage = 'Pending Review';

      // Add ticket action
      await db.collection('ticketActions').add({
        userId: req.userId,
        ticketId: req.params.ticketId,
        actionType: 'View',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        details: 'Ticket viewed for the first time'
      });
    }

    res.json(ticket);
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

      // Add ticket action
      await db.collection('ticketActions').add({
        userId: req.userId,
        ticketId: ticketId,
        actionType: 'Review',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        details: 'Ticket moved to Under Review stage'
      });
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

// add sample data for test
async function addSampleData() {
  try {
    // Add sample users
    const users = [
      { username: 'user1', password: await bcrypt.hash('password1', 10), exp: 100, ticketTokens: 50, badges: ['Helper'] },
      { username: 'user2', password: await bcrypt.hash('password2', 10), exp: 150, ticketTokens: 75, badges: ['Helper', 'Lurker'] },
      { username: 'user3', password: await bcrypt.hash('password3', 10), exp: 200, ticketTokens: 100, badges: ['Helper', 'Analyst'] }
    ];

    const userRefs = [];
    for (const user of users) {
      const userRef = await db.collection('users').add(user);
      userRefs.push(userRef);
    }

    // Add sample tickets
    const tickets = [
      { title: 'Bug in login page', description: 'Users unable to log in', createdBy: 'user1', creationDate: admin.firestore.FieldValue.serverTimestamp(), lastUpdateDate: admin.firestore.FieldValue.serverTimestamp(), stage: 'Unseen', priority: 'Normal', currentTurn: null },
      { title: 'Feature request: Dark mode', description: 'Implement dark mode for better user experience', createdBy: 'user2', creationDate: admin.firestore.FieldValue.serverTimestamp(), lastUpdateDate: admin.firestore.FieldValue.serverTimestamp(), stage: 'Pending Review', priority: 'High', currentTurn: null },
      { title: 'Performance optimization needed', description: 'App is slow on older devices', createdBy: 'user3', creationDate: admin.firestore.FieldValue.serverTimestamp(), lastUpdateDate: admin.firestore.FieldValue.serverTimestamp(), stage: 'Under Review', priority: 'Normal', currentTurn: null }
    ];

    for (const ticket of tickets) {
      const ticketRef = await db.collection('tickets').add(ticket);

      // Add sample messages for each ticket
      const messages = [
        { userId: userRefs[0].id, username: 'user1', message: 'I can reproduce this issue', timestamp: admin.firestore.FieldValue.serverTimestamp() },
        { userId: userRefs[1].id, username: 'user2', message: 'Let me take a look at it', timestamp: admin.firestore.FieldValue.serverTimestamp() },
        { userId: userRefs[2].id, username: 'user3', message: 'I think I found the problem', timestamp: admin.firestore.FieldValue.serverTimestamp() }
      ];

      for (const message of messages) {
        await db.collection('tickets').doc(ticketRef.id).collection('messages').add(message);
      }

      // Add sample ticket actions
      const actions = [
        { userId: userRefs[0].id, ticketId: ticketRef.id, actionType: 'Create', timestamp: admin.firestore.FieldValue.serverTimestamp(), details: 'Ticket created' },
        { userId: userRefs[1].id, ticketId: ticketRef.id, actionType: 'View', timestamp: admin.firestore.FieldValue.serverTimestamp(), details: 'Ticket viewed' },
        { userId: userRefs[2].id, ticketId: ticketRef.id, actionType: 'Review', timestamp: admin.firestore.FieldValue.serverTimestamp(), details: 'Ticket reviewed' }
      ];

      for (const action of actions) {
        await db.collection('ticketActions').add(action);
      }
    }

    // Add sample team
    const team = {
      name: 'Dream Team',
      members: userRefs.map(ref => ref.id),
      exp: 450,
      ticketTokens: 225
    };
    await db.collection('teams').add(team);

    // Add sample leaderboard
    const leaderboard = {
      type: 'Individual',
      entries: [
        { userId: userRefs[2].id, score: 200, rank: 1 },
        { userId: userRefs[1].id, score: 150, rank: 2 },
        { userId: userRefs[0].id, score: 100, rank: 3 }
      ],
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('leaderboards').add(leaderboard);

    // Add sample badges
    const badges = [
      { name: 'Helper', description: 'Assisted in solving tickets', levels: [{ level: 1, requirements: 'Help solve 5 tickets', rewards: '10 Ticket Tokens' }] },
      { name: 'Lurker', description: 'Viewed many tickets', levels: [{ level: 1, requirements: 'View 10 tickets', rewards: '5 Ticket Tokens' }] },
      { name: 'Analyst', description: 'Reviewed multiple tickets', levels: [{ level: 1, requirements: 'Review 5 tickets', rewards: '15 Ticket Tokens' }] }
    ];

    for (const badge of badges) {
      await db.collection('badges').add(badge);
    }

    console.log('Sample data added successfully');
  } catch (error) {
    console.error('Error adding sample data:', error);
  }
}

addSampleData(); // call function to add sample data

// start server
app.listen(port, () => {
  console.log(`TickEvo server running on port ${port}`);
});