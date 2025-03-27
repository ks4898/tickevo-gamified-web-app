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

// init Firebase admin SDK
const serviceAccount = require('./tickevo-ticket-evolution-firebase-adminsdk-fbsvc-6e628ddddb.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// JWT secret key
const JWT_SECRET = '70724d8d89b3766b4b45cf61838142419d7ab90c7f6556577e94bbb9fa03a1fdad18cf5c8d27bcfe250eac323b5a7de9d9d4d60d68f0d2052b2b96a15b41a15b78697fb61f6810d3b37662bd0e194dd2da4d94de45268c1172ffc4950cc560b123cd9f4d5524995b2922bed0b3eda3389dce26e627b6bd34d80220534f4123a514bbc50ca21ebe66e27bc8b7facf8654eaa97e6c56e1af2d9c972072cd4a0a46431713470b463cfd12c54ee84ae0fb8dc99eb543ea29db38ca7bfd1f821b1919558f5dc8a7a6e9967cbc822dcd5f2c727217dbfe606726741ebd0b1c543ad12b762e9560a4951d0fdcd10c63c76b72efb76c4a26fca66ddadcad9c105748f59e';

// middleware to verify JWT token
const verifyToken = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(403).json({ error: 'No token provided' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Unauthorized' });
    req.userId = decoded.userId;
    next();
  });
};

// login endpoint
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

// signup endpoint
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

// create a new ticket
app.post('/api/create-ticket', verifyToken, async (req, res) => {
  const { title, description, priority } = req.body;
  try {
    const userDoc = await db.collection('users').doc(req.userId).get();
    const username = userDoc.data().username;
    const newTicket = await db.collection('tickets').add({
      title,
      description,
      createdBy: username,
      createdId: req.userId,
      creationDate: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdateDate: admin.firestore.FieldValue.serverTimestamp(),
      stage: 'Unseen', // Unseen by def
      priority: priority || 'Normal', // Normal by def
      currentTurn: null, // no one's turn by def
      queue: [] // empty turn que by def
    });
    res.json({ success: true, ticketId: newTicket.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// get all tickets
app.get('/api/tickets', verifyToken, async (req, res) => {
  try {
    const ticketsSnapshot = await db.collection('tickets').get();
    const tickets = ticketsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // sort tickets by priority (High first) and then alphabetically by title (to be changed to timebomb -> high -> older first)
    tickets.sort((a, b) => {
      if (a.priority === b.priority) {
        return a.title.localeCompare(b.title);
      }
      return a.priority === 'High' ? -1 : 1;
    });

    res.json(tickets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// get a specific ticket
app.get('/api/tickets/:ticketId', verifyToken, async (req, res) => {
  try {
    const ticketRef = db.collection('tickets').doc(req.params.ticketId);
    const ticketDoc = await ticketRef.get();
    if (!ticketDoc.exists) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    let ticket = ticketDoc.data();
    ticket.id = ticketDoc.id;

    const currentTime = admin.firestore.Timestamp.now();
    const timeDiff = currentTime.seconds - ticket.lastUpdateDate.seconds;

    // Add viewer to queue if not already present and not the creator
    if (req.userId !== ticket.createdId && !ticket.queue.includes(req.userId)) {
      ticket.queue.push(req.userId);
      await ticketRef.update({ queue: ticket.queue });
    }

    // Reset turn after 1 minute of inactivity
    if (timeDiff > 60 && ticket.currentTurn) {
      let queue = ticket.queue || [];
      let nextTurn = null;
      
      if (queue.length > 0) {
        nextTurn = queue.shift();
        queue.push(nextTurn);
      }
      
      await ticketRef.update({
        currentTurn: nextTurn,
        queue: queue,
        lastUpdateDate: currentTime
      });
      
      ticket.currentTurn = nextTurn;
      ticket.queue = queue;
      ticket.lastUpdateDate = currentTime;
    }

    // Set turn if not set
    if (!ticket.currentTurn && ticket.queue.length > 0) {
      ticket.currentTurn = ticket.queue[0];
      await ticketRef.update({ currentTurn: ticket.currentTurn });
    }

    // Update stage if necessary and viewer is not the creator
    if (ticket.stage === 'Unseen' && ticket.createdId !== req.userId) {
      await ticketRef.update({
        stage: 'Pending Review',
        lastUpdateDate: currentTime
      });
      ticket.stage = 'Pending Review';
    }

    res.json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// join ticket queue
app.post('/api/tickets/:ticketId/join-queue', verifyToken, async (req, res) => {
  try {
    const ticketRef = db.collection('tickets').doc(req.params.ticketId);
    await db.runTransaction(async (transaction) => {
      const ticketDoc = await transaction.get(ticketRef);
      if (!ticketDoc.exists) {
        throw new Error('Ticket not found');
      }
      const ticketData = ticketDoc.data();
      let queue = ticketData.queue || [];
      if (!queue.includes(req.userId) && req.userId !== ticketData.createdId) {
        queue.push(req.userId);
        if (!ticketData.currentTurn) {
          transaction.update(ticketRef, { queue, currentTurn: req.userId });
        } else {
          transaction.update(ticketRef, { queue });
        }
      }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// send a message in a ticket's chat
app.post('/api/tickets/:ticketId/messages', verifyToken, async (req, res) => {
  const { message } = req.body;
  const ticketId = req.params.ticketId;
  try {
    const ticketRef = db.collection('tickets').doc(ticketId);
    
    await db.runTransaction(async (transaction) => {
      const ticketDoc = await transaction.get(ticketRef);
      if (!ticketDoc.exists) {
        throw new Error('Ticket not found');
      }
      const ticketData = ticketDoc.data();
      
      // Check if it's the user's turn and not the creator in Unseen or Pending Review stages
      if (ticketData.currentTurn !== req.userId || 
         (ticketData.createdId === req.userId && 
          (ticketData.stage === 'Unseen' || ticketData.stage === 'Pending Review'))) {
        throw new Error('Not allowed to send message');
      }

      const userDoc = await db.collection('users').doc(req.userId).get();
      const username = userDoc.data().username;

      // Add message
      const messageRef = ticketRef.collection('messages').doc();
      transaction.set(messageRef, {
        userId: req.userId,
        username: username,
        message,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      // Update stage if necessary
      if (ticketData.stage === 'Pending Review' && ticketData.createdId !== req.userId) {
        transaction.update(ticketRef, { 
          stage: 'Under Review',
          lastUpdateDate: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      // Update turn
      let queue = ticketData.queue || [];
      queue = queue.filter(id => id !== req.userId);
      let nextTurn = null;
      
      if (queue.length > 0) {
        nextTurn = queue[0];
      } else {
        // Add all users including creator to queue
        const allUsers = await db.collection('users').get();
        queue = allUsers.docs.map(doc => doc.id).filter(id => id !== req.userId);
        if (queue.length > 0) {
          nextTurn = queue[0];
        }
      }

      transaction.update(ticketRef, {
        currentTurn: nextTurn,
        queue: queue,
        lastUpdateDate: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// get chat messages for a specific ticket
app.get('/api/tickets/:ticketId/messages', verifyToken, async (req, res) => {
  try {
    const messagesSnapshot = await db.collection('tickets').doc(req.params.ticketId).collection('messages')
      .orderBy('timestamp', 'asc') // ascending order
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

// add sample data for test ...DEPRECATED...
async function addSampleData() {
  try {
    // add sample users
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

    /*// add sample tickets
    const tickets = [
      { title: 'Bug in login page', description: 'Users unable to log in', createdBy: 'user1', creationDate: admin.firestore.FieldValue.serverTimestamp(), lastUpdateDate: admin.firestore.FieldValue.serverTimestamp(), stage: 'Unseen', priority: 'Normal', currentTurn: null },
      { title: 'Feature request: Dark mode', description: 'Implement dark mode for better user experience', createdBy: 'user2', creationDate: admin.firestore.FieldValue.serverTimestamp(), lastUpdateDate: admin.firestore.FieldValue.serverTimestamp(), stage: 'Pending Review', priority: 'High', currentTurn: null },
      { title: 'Performance optimization needed', description: 'App is slow on older devices', createdBy: 'user3', creationDate: admin.firestore.FieldValue.serverTimestamp(), lastUpdateDate: admin.firestore.FieldValue.serverTimestamp(), stage: 'Under Review', priority: 'Normal', currentTurn: null }
    ];

    for (const ticket of tickets) {
      const ticketRef = await db.collection('tickets').add(ticket);
    }
      // add sample messages for each ticket
      const messages = [
        { userId: userRefs[0].id, username: 'user1', message: 'I can reproduce this issue', timestamp: admin.firestore.FieldValue.serverTimestamp() },
        { userId: userRefs[1].id, username: 'user2', message: 'Let me take a look at it', timestamp: admin.firestore.FieldValue.serverTimestamp() },
        { userId: userRefs[2].id, username: 'user3', message: 'I think I found the problem', timestamp: admin.firestore.FieldValue.serverTimestamp() }
      ];

      for (const message of messages) {
        await db.collection('tickets').doc(ticketRef.id).collection('messages').add(message);
      }

      // add sample ticket actions
      const actions = [
        { userId: userRefs[0].id, ticketId: ticketRef.id, actionType: 'Create', timestamp: admin.firestore.FieldValue.serverTimestamp(), details: 'Ticket created' },
        { userId: userRefs[1].id, ticketId: ticketRef.id, actionType: 'View', timestamp: admin.firestore.FieldValue.serverTimestamp(), details: 'Ticket viewed' },
        { userId: userRefs[2].id, ticketId: ticketRef.id, actionType: 'Review', timestamp: admin.firestore.FieldValue.serverTimestamp(), details: 'Ticket reviewed' }
      ];

      for (const action of actions) {
        await db.collection('ticketActions').add(action);
      }
    }

    // add sample team
    const team = {
      name: 'Dream Team',
      members: userRefs.map(ref => ref.id),
      exp: 450,
      ticketTokens: 225
    };
    await db.collection('teams').add(team);

    // add sample leaderboard
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

    // add sample badges
    const badges = [
      { name: 'Helper', description: 'Assisted in solving tickets', levels: [{ level: 1, requirements: 'Help solve 5 tickets', rewards: '10 Ticket Tokens' }] },
      { name: 'Lurker', description: 'Viewed many tickets', levels: [{ level: 1, requirements: 'View 10 tickets', rewards: '5 Ticket Tokens' }] },
      { name: 'Analyst', description: 'Reviewed multiple tickets', levels: [{ level: 1, requirements: 'Review 5 tickets', rewards: '15 Ticket Tokens' }] }
    ];

    for (const badge of badges) {
      await db.collection('badges').add(badge);
    }*/

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