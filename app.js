const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize Firebase Admin SDK
const serviceAccount = require('tickevo-ticket-evolution-firebase-adminsdk-fbsvc-6e628ddddb');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://your-project-id.firebaseio.com'
});

const db = admin.database();

// Check current turn
app.get('/api/check-turn', (req, res) => {
  const turnRef = db.ref('currentTurn');
  turnRef.once('value', (snapshot) => {
    res.json({ currentTurn: snapshot.val() });
  });
});

// End turn
app.post('/api/end-turn', (req, res) => {
  const { currentUser, nextUser } = req.body;
  const turnRef = db.ref('currentTurn');
  turnRef.set(nextUser)
    .then(() => res.json({ success: true }))
    .catch((error) => res.status(500).json({ error: error.message }));
});

// Perform action (only allowed during user's turn)
app.post('/api/perform-action', (req, res) => {
  const { userId, action } = req.body;
  const turnRef = db.ref('currentTurn');
  turnRef.once('value', (snapshot) => {
    if (snapshot.val() === userId) {
      // Perform the action (e.g., update ticket stage)
      const ticketRef = db.ref('tickets').push();
      ticketRef.set({
        action: action,
        userId: userId,
        timestamp: admin.database.ServerValue.TIMESTAMP
      }).then(() => {
        res.json({ success: true, message: 'Action performed' });
      }).catch((error) => {
        res.status(500).json({ error: error.message });
      });
    } else {
      res.status(403).json({ error: 'Not your turn' });
    }
  });
});

// Send chat message
app.post('/api/send-message', (req, res) => {
  const { userId, message } = req.body;
  const messagesRef = db.ref('messages');
  messagesRef.push({
    userId,
    message,
    timestamp: admin.database.ServerValue.TIMESTAMP
  })
    .then(() => res.json({ success: true }))
    .catch((error) => res.status(500).json({ error: error.message }));
});

// Get chat messages
app.get('/api/get-messages', (req, res) => {
  const messagesRef = db.ref('messages');
  messagesRef.orderByChild('timestamp').limitToLast(20).once('value')
    .then((snapshot) => {
      res.json(snapshot.val());
    })
    .catch((error) => res.status(500).json({ error: error.message }));
});

app.listen(port, () => {
  console.log(`TickEvo server running on port ${port}`);
});
