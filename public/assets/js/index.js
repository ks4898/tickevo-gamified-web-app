const currentUserId = 'user1'; // Simulating logged-in user
const nextUserId = 'user2'; // Simulating next user in turn

function checkTurn() {
  fetch('/api/check-turn')
    .then(response => response.json())
    .then(data => {
      document.getElementById('current-turn').textContent = data.currentTurn;
      if (data.currentTurn === currentUserId) {
        enableActions();
      } else {
        disableActions();
      }
    });
}

function endTurn() {
  fetch('/api/end-turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentUser: currentUserId, nextUser: nextUserId })
  })
    .then(response => response.json())
    .then(data => {
      if (data.success) {
        checkTurn();
      }
    });
}

function performAction() {
  const action = document.getElementById('action-select').value;
  fetch('/api/perform-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: currentUserId, action })
  })
    .then(response => response.json())
    .then(data => {
      if (data.success) {
        alert('Action performed: ' + action);
      }
    });
}

function sendMessage() {
  const message = document.getElementById('message-input').value;
  fetch('/api/send-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: currentUserId, message })
  })
    .then(response => response.json())
    .then(data => {
      if (data.success) {
        document.getElementById('message-input').value = '';
        loadMessages();
      }
    });
}

function loadMessages() {
  fetch('/api/get-messages')
    .then(response => response.json())
    .then(messages => {
      const messagesDiv = document.getElementById('messages');
      messagesDiv.innerHTML = '';
      for (const key in messages) {
        const message = messages[key];
        messagesDiv.innerHTML += `<p>${message.userId}: ${message.message}</p>`;
      }
    });
}

function enableActions() {
  document.getElementById('end-turn-btn').disabled = false;
  document.getElementById('perform-action-btn').disabled = false;
}

function disableActions() {
  document.getElementById('end-turn-btn').disabled = true;
  document.getElementById('perform-action-btn').disabled = true;
}

document.getElementById('end-turn-btn').addEventListener('click', endTurn);
document.getElementById('perform-action-btn').addEventListener('click', performAction);
document.getElementById('send-message-btn').addEventListener('click', sendMessage);

// Initial load
checkTurn();
loadMessages();
setInterval(checkTurn, 5000);
setInterval(loadMessages, 5000);