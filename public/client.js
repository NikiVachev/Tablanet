const socket = io();

let state = null;
let renderedState = null;
let selectedHandCardId = null;
let messageTimer = null;
let isAnimating = false;
let pendingState = null;
let lastAnimatedActionId = null;
let animationTimers = [];
let currentRoomCode = null;
let myPlayerNumber = null;
let hasJoinedRoom = false;
let scaleIndex = 0;
const scaleLevels = [1, 0.85, 0.7, 0.6];
const selectedTableCardIds = new Set();
const sessionStorageKey = 'tablanetRoomSession';

const elements = {
  app: document.getElementById('app'),
  joinBar: document.getElementById('joinBar'),
  joinPanel: document.getElementById('joinPanel'),
  createRoomButton: document.getElementById('createRoomButton'),
  joinRoomButton: document.getElementById('joinRoomButton'),
  roomCodeInput: document.getElementById('roomCodeInput'),
  roomCodeDisplay: document.getElementById('roomCodeDisplay'),
  currentRoomCode: document.getElementById('currentRoomCode'),
  copyRoomCodeButton: document.getElementById('copyRoomCodeButton'),
  showQrButton: document.getElementById('showQrButton'),
  qrPanel: document.getElementById('qrPanel'),
  qrImage: document.getElementById('qrImage'),
  qrUrl: document.getElementById('qrUrl'),
  statusText: document.getElementById('statusText'),
  tableCards: document.getElementById('tableCards'),
  handCards: document.getElementById('handCards'),
  takeButton: document.getElementById('takeButton'),
  throwButton: document.getElementById('throwButton'),
  turnText: document.getElementById('turnText'),
  message: document.getElementById('message'),
  actionMessage: document.getElementById('actionMessage'),
  actionPreview: document.getElementById('actionPreview'),
  lastActionPanel: document.getElementById('lastActionPanel'),
  lastActionTitle: document.getElementById('lastActionTitle'),
  endScreen: document.getElementById('endScreen'),
  winnerTitle: document.getElementById('winnerTitle'),
  finalScore: document.getElementById('finalScore'),
  playAgainButton: document.getElementById('playAgainButton'),
  deckCount: document.getElementById('deckCount'),
  opponentName: document.getElementById('opponentName'),
  opponentHand: document.getElementById('opponentHand'),
  opponentScore: document.getElementById('opponentScore'),
  opponentCaptured: document.getElementById('opponentCaptured'),
  opponentTabli: document.getElementById('opponentTabli'),
  playerName: document.getElementById('playerName'),
  playerScore: document.getElementById('playerScore'),
  playerCaptured: document.getElementById('playerCaptured'),
  playerTabli: document.getElementById('playerTabli'),
  historyList: document.getElementById('historyList'),
  scaleButton: document.getElementById('scaleButton')
};

elements.createRoomButton.addEventListener('click', () => {
  clearRoomSession();
  socket.emit('createRoom');
});
elements.joinRoomButton.addEventListener('click', joinRoomFromInput);
elements.roomCodeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') joinRoomFromInput();
});
elements.copyRoomCodeButton.addEventListener('click', copyRoomCode);
elements.showQrButton.addEventListener('click', toggleQrPanel);
elements.scaleButton.addEventListener('click', cycleScale);
window.addEventListener('resize', applyScale);
initScale();

elements.takeButton.addEventListener('click', () => {
  socket.emit('takeCards', {
    handCardId: selectedHandCardId,
    tableCardIds: [...selectedTableCardIds]
  });
});

elements.throwButton.addEventListener('click', () => {
  socket.emit('throwCard', { handCardId: selectedHandCardId });
});

elements.playAgainButton.addEventListener('click', () => {
  resetClientRound();
  elements.playAgainButton.disabled = true;
  socket.emit('playAgain');
});

socket.on('connect', () => {
  tryAutoRejoin();
});

if (socket.connected) {
  tryAutoRejoin();
}

socket.on('state', (nextState) => {
  state = nextState;
  if (nextState.roomCode) {
    currentRoomCode = nextState.roomCode;
    myPlayerNumber = nextState.playerNumber || nextState.playerId;
    hasJoinedRoom = true;
    saveRoomSession(nextState);
    renderRoomCode();
  }

  if (isAnimating) {
    pendingState = nextState;
    return;
  }

  handleState(nextState);
});

socket.on('roomJoined', ({ roomCode, playerNumber, playerToken, message }) => {
  currentRoomCode = roomCode;
  myPlayerNumber = playerNumber;
  hasJoinedRoom = true;
  saveRoomSession({ roomCode, playerNumber, playerToken });
  renderRoomCode();
  showLobbyMessage(message || `Joined room ${roomCode}`, true);
});

socket.on('rejoinFailed', (message) => {
  clearRoomSession();
  resetToLobby(message || 'Rejoin failed', false);
});

socket.on('roomExpired', (message) => {
  clearRoomSession();
  resetToLobby(message || 'Room expired', false);
});

socket.on('lobbyState', ({ message }) => {
  showLobbyMessage(message, true);
});

socket.on('lobbyError', (message) => {
  showLobbyMessage(message, false);
});

socket.on('roomMessage', (message) => {
  showMessage(message, true, 2200);
});

socket.on('errorMessage', (message) => {
  if (message) {
    showMessage(message, false, 2600);
  }
});

function handleState(nextState) {
  const action = nextState.lastAction;

  if (!action) {
    clearAnimationTimers();
    lastAnimatedActionId = null;
    isAnimating = false;
    pendingState = null;
    clearActionPreview();
  }

  const shouldAnimate =
    renderedState &&
    action &&
    action.id !== lastAnimatedActionId &&
    ['capture', 'throw', 'tabla'].includes(action.type);

  if (shouldAnimate) {
    animateOpponentAction(action, nextState);
    return;
  }

  applyState(nextState);
}

function applyState(nextState) {
  renderedState = nextState;
  clearSelectionsForState(nextState);
  render();
}

function clearSelectionsForState(nextState) {
  if (!nextState.hand.some((card) => card.id === selectedHandCardId)) {
    selectedHandCardId = null;
  }

  for (const cardId of [...selectedTableCardIds]) {
    if (!nextState.table.some((card) => card.id === cardId)) {
      selectedTableCardIds.delete(cardId);
    }
  }
}

function animateOpponentAction(action, nextState) {
  clearAnimationTimers();
  isAnimating = true;
  lastAnimatedActionId = action.id;
  selectedTableCardIds.clear();
  selectedHandCardId = null;
  const actorIsMe = action.playerId === nextState.playerId;
  const handSourceClass = actorIsMe ? 'from-player-hand' : 'from-opponent-hand';
  const throwClass = actorIsMe ? 'throw-from-player' : 'throw-from-opponent';
  const collectClass = actorIsMe ? 'collecting-to-player' : 'collecting-to-opponent';
  const opponentHiddenIndex = actorIsMe ? null : getOpponentAnimatedCardIndex(action);

  render({
    disableActions: true,
    hiddenHandCardId: actorIsMe ? action.playedCard.id : null,
    hiddenOpponentCardIndex: opponentHiddenIndex
  });

  if (action.type === 'throw') {
    setActionPreview(action.playedCard, throwClass);
    showMessage(action.message, true, 0);
    finishAnimationAfter(action, nextState, 1150);
    return;
  }

  setActionPreview(action.playedCard, handSourceClass);
  showMessage(`Player ${action.playerId} играе ${action.playedCard.label}`, true, 0);

  setAnimationTimer(() => {
    const capturedIds = action.capturedCards.map((card) => card.id);
    render({
      animatedTableIds: capturedIds,
      disableActions: true,
      hiddenHandCardId: actorIsMe ? action.playedCard.id : null,
      hiddenOpponentCardIndex: opponentHiddenIndex,
      animationClass: 'capture-glow'
    });
    updateActionPreviewClass('capture-glow');
    showMessage(`Player ${action.playerId} избира комбинация`, true, 0);
  }, 550);

  setAnimationTimer(() => {
    if (action.type !== 'throw') {
      const capturedIds = action.capturedCards.map((card) => card.id);
      render({
        animatedTableIds: capturedIds,
        disableActions: true,
        hiddenHandCardId: actorIsMe ? action.playedCard.id : null,
        hiddenOpponentCardIndex: opponentHiddenIndex,
        animationClass: collectClass
      });
      updateActionPreviewClass(collectClass);
      showMessage(action.tabla ? 'Табла! +1 точка' : action.message, true, 0);
    }
  }, 1200);

  finishAnimationAfter(action, nextState, 2050);
}

function finishAnimationAfter(action, nextState, delay) {
  setAnimationTimer(() => {
    clearActionPreview();
    isAnimating = false;
    applyState(nextState);
    showMessage(nextState.status === 'finished' ? nextState.message : action.message, true, 2800);

    if (action.extraMessages?.length) {
      window.setTimeout(() => showMessage(action.extraMessages[0], true, 2200), 900);
    }

    if (pendingState) {
      const queued = pendingState;
      pendingState = null;
      handleState(queued);
    }
  }, delay);
}

function render(options = {}) {
  const viewState = renderedState;
  if (!viewState) return;

  const isJoined = Boolean(viewState.playerId);
  const isMyTurn = viewState.status === 'playing' && viewState.playerId === viewState.currentPlayer;
  const disableActions = options.disableActions || isAnimating;

  renderCards(elements.tableCards, viewState.table, 'table', { ...options, isMyTurn });
  renderCards(elements.handCards, viewState.hand, 'hand', { ...options, isMyTurn });
  renderOpponentArea(viewState, options);
  renderPlayerArea(viewState);
  renderActionPanel(viewState, isMyTurn);
  renderEndScreen(viewState);
  renderHistory(viewState.history || []);
  renderAppChrome(viewState, isMyTurn);

  elements.takeButton.disabled = disableActions || !isMyTurn || !selectedHandCardId || selectedTableCardIds.size === 0;
  elements.throwButton.disabled = disableActions || !isMyTurn || !selectedHandCardId;

  elements.statusText.textContent = statusText(viewState);
  elements.turnText.textContent = turnText(viewState, isMyTurn);

  if (!isAnimating) {
    showMessage(viewState.message, true, viewState.status === 'playing' ? 2400 : 0);
  }
}

function renderAppChrome(viewState, isMyTurn) {
  const isJoined = Boolean(viewState.playerId);
  const isActiveGame = viewState.status === 'playing' || viewState.status === 'finished';
  elements.app.classList.toggle('is-joined', isJoined);
  elements.app.classList.toggle('is-playing', isActiveGame);
  elements.app.classList.toggle('is-my-turn', isMyTurn);
  elements.joinBar.hidden = isActiveGame;
  elements.scaleButton.hidden = !isActiveGame;
}

function renderOpponentArea(viewState, options = {}) {
  const playerId = viewState.playerId;
  const opponentId = playerId === 1 ? 2 : playerId === 2 ? 1 : 2;
  const opponentStats = viewState.players?.[opponentId] || emptyStats();

  elements.opponentName.textContent = playerId ? `Player ${opponentId}` : 'Player -';
  elements.opponentScore.textContent = opponentStats.score;
  elements.opponentCaptured.textContent = opponentStats.capturedCount;
  elements.opponentTabli.textContent = opponentStats.tabli;
  renderOpponentHand(opponentStats.handCount, options.hiddenOpponentCardIndex);
}

function renderPlayerArea(viewState) {
  const playerId = viewState.playerId;
  const playerStats = viewState.players?.[playerId] || emptyStats();

  elements.deckCount.textContent = viewState.deckCount ?? 0;
  elements.playerName.textContent = playerId ? `Player ${playerId}` : 'Не си в игра';
  elements.playerScore.textContent = playerStats.score;
  elements.playerCaptured.textContent = playerStats.capturedCount;
  elements.playerTabli.textContent = playerStats.tabli;
}

function renderActionPanel(viewState, isMyTurn) {
  const action = viewState.lastAction;
  elements.lastActionPanel.classList.toggle('tabla-panel', Boolean(action?.tabla));

  if (viewState.status === 'finished') {
    elements.lastActionTitle.textContent = 'Край';
    return;
  }

  if (isMyTurn) {
    elements.lastActionTitle.textContent = 'Твой ред';
    return;
  }

  if (action) {
    elements.lastActionTitle.textContent = `Player ${action.playerId}`;
    return;
  }

  elements.lastActionTitle.textContent = 'Последен ход';
}

function renderEndScreen(viewState) {
  const isFinished = viewState.status === 'finished';
  elements.endScreen.hidden = !isFinished;
  elements.playAgainButton.disabled = false;

  if (!isFinished) return;

  const result = viewState.finalResult;
  const score1 = result?.scores?.[1] ?? viewState.players?.[1]?.score ?? 0;
  const score2 = result?.scores?.[2] ?? viewState.players?.[2]?.score ?? 0;

  elements.winnerTitle.textContent = result?.winner
    ? `Player ${result.winner} спечели`
    : 'Равен резултат';
  elements.finalScore.textContent = `Player 1: ${score1} точки · Player 2: ${score2} точки`;
}

function renderOpponentHand(count = 0, hiddenIndex = null) {
  elements.opponentHand.innerHTML = '';

  for (let i = 0; i < count; i += 1) {
    const center = (count - 1) / 2;
    const offset = i - center;
    const cardBack = document.createElement('div');
    cardBack.className = 'card-back';
    if (hiddenIndex === i) {
      cardBack.classList.add('hidden-source');
    }
    cardBack.style.setProperty('--tilt', `${offset * 5}deg`);
    cardBack.style.setProperty('--lift', `${Math.abs(offset) * 0.04}rem`);
    elements.opponentHand.appendChild(cardBack);
  }
}

function getOpponentAnimatedCardIndex(action) {
  const playerId = renderedState?.playerId;
  const opponentId = playerId === 1 ? 2 : 1;
  const count = renderedState?.players?.[opponentId]?.handCount || 0;
  if (!count) return null;
  return action.id % count;
}

function renderHistory(history) {
  elements.historyList.innerHTML = '';

  if (!history.length) {
    const item = document.createElement('li');
    item.textContent = 'Още няма ходове.';
    elements.historyList.appendChild(item);
    return;
  }

  for (const entry of history.slice(0, 1)) {
    const item = document.createElement('li');
    item.textContent = entry.text;
    elements.historyList.appendChild(item);
  }
}

function renderCards(container, cards, area, options = {}) {
  container.innerHTML = '';

  if (!cards.length) {
    const empty = document.createElement('span');
    empty.className = 'empty';
    empty.textContent = 'Няма карти.';
    container.appendChild(empty);
    return;
  }

  for (const card of cards) {
    const button = createCardElement(card);
    const isAnimated = options.animatedTableIds?.includes(card.id);

    if (area === 'hand' && selectedHandCardId === card.id) {
      button.classList.add('selected');
    }

    if (area === 'table' && selectedTableCardIds.has(card.id)) {
      button.classList.add('selected');
    }

    if (isAnimated) {
      button.classList.add(options.animationClass || 'capture-glow');
    }

    if (area === 'hand' && options.hiddenHandCardId === card.id) {
      button.classList.add('hidden-source');
    }

    const locked = options.disableActions || isAnimating;
    button.classList.toggle('locked', locked);
    button.setAttribute('aria-disabled', locked ? 'true' : 'false');

    button.addEventListener('click', () => {
      if (locked) return;

      if (!options.isMyTurn) {
        showMessage('Изчакай противника', false, 1800);
        return;
      }

      if (area === 'hand') {
        selectedHandCardId = selectedHandCardId === card.id ? null : card.id;
      } else if (selectedTableCardIds.has(card.id)) {
        selectedTableCardIds.delete(card.id);
      } else {
        selectedTableCardIds.add(card.id);
      }

      render();
    });

    container.appendChild(button);
  }
}

function createCardElement(card) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `card ${['diamonds', 'hearts'].includes(card.suit) ? 'red' : 'black'}`;
  button.innerHTML = `
    <span class="corner top">${card.rank}<small>${card.suitSymbol}</small></span>
    <span class="pip">${card.suitSymbol}</span>
    <span class="corner bottom">${card.rank}<small>${card.suitSymbol}</small></span>
  `;
  button.setAttribute('aria-label', card.label);
  return button;
}

function setActionPreview(card, extraClass) {
  elements.actionPreview.innerHTML = '';
  const previewCard = createCardElement(card);
  previewCard.disabled = true;
  previewCard.classList.add('preview-card', ...extraClass.split(' ').filter(Boolean));
  elements.actionPreview.appendChild(previewCard);
  elements.actionPreview.classList.add('active');
}

function updateActionPreviewClass(extraClass) {
  const previewCard = elements.actionPreview.querySelector('.preview-card');
  if (!previewCard) return;

  const colorClass = previewCard.classList.contains('red') ? 'red' : 'black';
  previewCard.className = `card ${colorClass} preview-card ${extraClass}`;
}

function clearActionPreview() {
  elements.actionPreview.innerHTML = '';
  elements.actionPreview.classList.remove('active');
}

function resetClientRound() {
  clearAnimationTimers();
  window.clearTimeout(messageTimer);
  isAnimating = false;
  pendingState = null;
  lastAnimatedActionId = null;
  selectedHandCardId = null;
  selectedTableCardIds.clear();
  clearActionPreview();
  elements.endScreen.hidden = true;
}

function setAnimationTimer(callback, delay) {
  const timerId = window.setTimeout(() => {
    animationTimers = animationTimers.filter((id) => id !== timerId);
    callback();
  }, delay);
  animationTimers.push(timerId);
}

function clearAnimationTimers() {
  for (const timerId of animationTimers) {
    window.clearTimeout(timerId);
  }
  animationTimers = [];
}

function statusText(viewState) {
  if (!viewState.playerId) return viewState.message || 'Избери Player 1 или Player 2.';
  if (viewState.status === 'waiting') return `Ти си Player ${viewState.playerId}. Изчаква се втори играч.`;
  if (viewState.status === 'finished') return `Ти си Player ${viewState.playerId}. Играта приключи.`;
  return `Ти си Player ${viewState.playerId}.`;
}

function turnText(viewState, isMyTurn) {
  if (viewState.status === 'waiting') return 'Изчаква се втори играч.';
  if (viewState.status === 'finished') return 'Играта приключи.';
  if (isMyTurn) return 'Твой ред е';
  return 'Изчакай противника';
}

function showMessage(message, ok, timeout = 2500) {
  window.clearTimeout(messageTimer);
  elements.message.textContent = message || '';
  elements.message.classList.toggle('ok', ok);
  elements.actionMessage.textContent = ok ? '' : message;

  if (timeout > 0) {
    messageTimer = window.setTimeout(() => {
      elements.message.textContent = '';
      elements.actionMessage.textContent = '';
    }, timeout);
  }
}

function emptyStats() {
  return { handCount: 0, score: 0, capturedCount: 0, tabli: 0 };
}

function joinRoomFromInput() {
  const roomCode = elements.roomCodeInput.value.trim();
  if (!roomCode) {
    showLobbyMessage('Enter room code', false);
    return;
  }
  clearRoomSession();
  socket.emit('joinRoom', { roomCode });
}

async function copyRoomCode() {
  if (!currentRoomCode) return;

  try {
    await navigator.clipboard.writeText(currentRoomCode);
    showLobbyMessage(`Copied room code: ${currentRoomCode}`, true);
  } catch (error) {
    showLobbyMessage(`Room code: ${currentRoomCode}`, true);
  }
}

function renderRoomCode() {
  elements.roomCodeDisplay.hidden = !currentRoomCode;
  elements.currentRoomCode.textContent = currentRoomCode || '----';
  elements.createRoomButton.disabled = hasJoinedRoom;
  elements.joinRoomButton.disabled = hasJoinedRoom;
  elements.roomCodeInput.disabled = hasJoinedRoom;
}

function showLobbyMessage(message, ok) {
  elements.statusText.textContent = message || '';
  elements.statusText.classList.toggle('error-text', !ok);
}

function saveRoomSession(session) {
  const roomCode = session.roomCode || currentRoomCode;
  const playerNumber = session.playerNumber || session.playerId || myPlayerNumber;
  const playerToken = session.playerToken || getSavedRoomSession()?.playerToken;
  if (!roomCode || !playerNumber || !playerToken) return;

  localStorage.setItem(
    sessionStorageKey,
    JSON.stringify({
      roomCode,
      playerNumber,
      playerToken,
      savedAt: Date.now()
    })
  );
}

function getSavedRoomSession() {
  try {
    return JSON.parse(localStorage.getItem(sessionStorageKey) || 'null');
  } catch (error) {
    return null;
  }
}

function clearRoomSession() {
  localStorage.removeItem(sessionStorageKey);
}

function tryAutoRejoin() {
  if (hasJoinedRoom) return;
  const savedSession = getSavedRoomSession();
  if (!savedSession?.roomCode || !savedSession?.playerNumber || !savedSession?.playerToken) return;

  currentRoomCode = savedSession.roomCode;
  myPlayerNumber = savedSession.playerNumber;
  showLobbyMessage(`Rejoining room ${savedSession.roomCode}...`, true);
  renderRoomCode();
  socket.emit('rejoinRoom', savedSession);
}

function resetToLobby(message, ok) {
  resetClientRound();
  state = null;
  renderedState = null;
  currentRoomCode = null;
  myPlayerNumber = null;
  hasJoinedRoom = false;
  selectedHandCardId = null;
  selectedTableCardIds.clear();

  elements.app.classList.remove('is-joined', 'is-playing', 'is-my-turn');
  elements.joinBar.hidden = false;
  elements.scaleButton.hidden = true;
  elements.createRoomButton.disabled = false;
  elements.joinRoomButton.disabled = false;
  elements.roomCodeInput.disabled = false;
  elements.roomCodeDisplay.hidden = true;
  elements.currentRoomCode.textContent = '----';
  elements.tableCards.innerHTML = '';
  elements.handCards.innerHTML = '';
  elements.opponentHand.innerHTML = '';
  showLobbyMessage(message, ok);
}

function initScale() {
  const savedScale = Number(localStorage.getItem('tablanetScale') || '1');
  const savedIndex = scaleLevels.findIndex((scale) => scale === savedScale);
  scaleIndex = savedIndex >= 0 ? savedIndex : 0;
  applyScale();
  elements.scaleButton.hidden = true;
}

function cycleScale() {
  scaleIndex = (scaleIndex + 1) % scaleLevels.length;
  applyScale();
}

function applyScale() {
  const selectedScale = scaleLevels[scaleIndex];
  const scale = window.matchMedia('(max-width: 820px)').matches ? 1 : selectedScale;
  const root = document.documentElement;
  root.style.setProperty('--card-scale', scale);
  root.style.setProperty('--card-width', `${roundRem(4.85 * scale)}rem`);
  root.style.setProperty('--card-height', `${roundRem(6.8 * scale)}rem`);
  root.style.setProperty('--card-gap', `${roundRem(0.52 * scale)}rem`);
  root.style.setProperty('--card-padding', `${roundRem(0.25 * scale)}rem`);
  root.style.setProperty('--corner-font', `${roundRem(0.8 * scale)}rem`);
  root.style.setProperty('--corner-offset', `${roundRem(0.34 * scale)}rem`);
  root.style.setProperty('--pip-font', `${roundRem(2 * scale)}rem`);
  root.style.setProperty('--card-back-width', `${roundRem(3.35 * scale)}rem`);
  root.style.setProperty('--card-back-height', `${roundRem(4.75 * scale)}rem`);
  root.style.setProperty('--card-back-margin', `${roundRem(-0.68 * scale)}rem`);
  root.style.setProperty('--preview-card-width', `${roundRem(5.43 * scale)}rem`);
  root.style.setProperty('--preview-card-height', `${roundRem(7.62 * scale)}rem`);
  root.style.setProperty('--felt-min-height', `${roundRem(Math.max(14, 22 * scale))}rem`);
  localStorage.setItem('tablanetScale', String(selectedScale));
  elements.scaleButton.textContent = `Scale ${Math.round(selectedScale * 100)}%`;
}

function roundRem(value) {
  return Math.round(value * 1000) / 1000;
}

async function toggleQrPanel() {
  if (!elements.qrPanel.hidden) {
    elements.qrPanel.hidden = true;
    return;
  }

  elements.qrPanel.hidden = false;

  if (elements.qrImage.src) return;

  try {
    const response = await fetch('/server-info');
    if (!response.ok) throw new Error('QR request failed');
    const info = await response.json();
    elements.qrImage.src = info.qrCode;
    elements.qrUrl.textContent = info.primaryUrl;
  } catch (error) {
    elements.qrUrl.textContent = 'QR кодът не можа да се зареди.';
  }
}
