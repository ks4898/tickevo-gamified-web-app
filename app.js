const express = require('express'); // express.js
const admin = require('firebase-admin'); // firebase
const cors = require('cors'); // cors, unused for now
const jwt = require('jsonwebtoken'); // JWT
const bcrypt = require('bcrypt'); // bcrypt hash
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
    
    // Check if user is already in the turn queue
    const turnDoc = await db.collection('tickets').doc('turnInfo').get();
    let userQueue = turnDoc.exists ? turnDoc.data().userQueue : [];
    let currentTurn = turnDoc.exists ? turnDoc.data().currentTurn : null;
    
    if (!userQueue.includes(userId)) {
      userQueue.push(userId);
      if (currentTurn === null) {
        currentTurn = userId;
      }
      await db.collection('tickets').doc('turnInfo').set({ userQueue, currentTurn });
    }
    
    res.json({ token, userId });
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

// get current turn
app.get('/api/current-turn', verifyToken, async (req, res) => {
  try {
    const turnDoc = await db.collection('tickets').doc('turnInfo').get();
    const { currentTurn, userQueue } = turnDoc.data();
    res.json({ currentTurn, isYourTurn: currentTurn === req.userId, userQueue });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// send chat message
app.post('/api/send-message', verifyToken, async (req, res) => {
  const { message } = req.body;
  try {
    const turnDoc = await db.collection('tickets').doc('turnInfo').get();
    const { currentTurn, userQueue } = turnDoc.data();
    
    if (currentTurn !== req.userId) {
      return res.status(403).json({ error: 'Not your turn' });
    }
    
    const userDoc = await db.collection('users').doc(req.userId).get();
    const username = userDoc.data().username;
    const newMessage = await db.collection('messages').add({
      userId: req.userId,
      username: username,
      message,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Update turn
    const currentIndex = userQueue.indexOf(currentTurn);
    const nextTurn = userQueue[(currentIndex + 1) % userQueue.length];
    await db.collection('tickets').doc('turnInfo').update({ 
      currentTurn: nextTurn,
      lastMessageId: newMessage.id
    });
    
    res.json({ success: true, nextTurn, messageId: newMessage.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// get chat messages
app.get('/api/get-messages', verifyToken, async (req, res) => {
  try {
    const messagesSnapshot = await db.collection('messages')
      .orderBy('timestamp', 'desc')
      .limit(20)
      .get();
    const messages = messagesSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    res.json(messages.reverse());
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