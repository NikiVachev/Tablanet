const SUITS = [
  { code: 'clubs', symbol: '♣', name: 'спатия' },
  { code: 'diamonds', symbol: '♦', name: 'каро' },
  { code: 'hearts', symbol: '♥', name: 'купа' },
  { code: 'spades', symbol: '♠', name: 'пика' }
];

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function createDeck() {
  let id = 1;
  return SUITS.flatMap((suit) =>
    RANKS.map((rank) => ({
      id: id++,
      rank,
      suit: suit.code,
      suitSymbol: suit.symbol,
      label: `${rank}${suit.symbol}`
    }))
  );
}

function shuffle(cards) {
  const result = [...cards];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function cardValues(card) {
  if (card.rank === 'A') return [1, 11];
  if (card.rank === 'J') return [12];
  if (card.rank === 'Q') return [13];
  if (card.rank === 'K') return [14];
  return [Number(card.rank)];
}

function possibleSums(cards) {
  return cards.reduce((sums, card) => {
    const nextSums = new Set();
    for (const sum of sums) {
      for (const value of cardValues(card)) {
        nextSums.add(sum + value);
      }
    }
    return nextSums;
  }, new Set([0]));
}

function scoreCapturedCards(cards) {
  return cards.reduce((score, card) => {
    if (['J', 'Q', 'K', '10'].includes(card.rank)) score += 1;
    if (card.rank === '10' && card.suit === 'diamonds') score += 1;
    if (card.rank === '2' && card.suit === 'clubs') score += 1;
    return score;
  }, 0);
}

class Game {
  constructor() {
    this.reset();
  }

  reset() {
    this.status = 'waiting';
    this.deck = [];
    this.table = [];
    this.currentPlayer = 1;
    this.lastCapturingPlayer = null;
    this.lastAction = null;
    this.actionId = 0;
    this.history = [];
    this.finalResult = null;
    this.message = 'Изчакват се двама играчи.';
    this.players = {
      1: { hand: [], captured: [], tabli: 0, score: 0 },
      2: { hand: [], captured: [], tabli: 0, score: 0 }
    };
  }

  start() {
    this.reset();
    this.status = 'playing';
    this.deck = shuffle(createDeck());
    this.table = this.deck.splice(0, 4);
    this.dealHands();
    this.currentPlayer = 1;
    this.message = 'Играта започна. Player 1 е на ход.';
    this.addHistory('Играта започна.');
  }

  dealHands() {
    const dealCount = Math.min(6, Math.floor(this.deck.length / 2));

    for (let i = 0; i < dealCount; i += 1) {
      this.players[1].hand.push(this.deck.shift());
      this.players[2].hand.push(this.deck.shift());
    }
  }

  takeCards(playerId, handCardId, tableCardIds = []) {
    const guard = this.validateTurn(playerId, handCardId);
    if (!guard.ok) return guard;

    if (!Array.isArray(tableCardIds) || tableCardIds.length === 0) {
      return { ok: false, message: 'Избери поне една карта от масата.' };
    }

    const player = this.players[playerId];
    const handCard = player.hand.find((card) => card.id === Number(handCardId));
    const selectedTableCards = tableCardIds
      .map((id) => this.table.find((card) => card.id === Number(id)))
      .filter(Boolean);

    if (selectedTableCards.length !== tableCardIds.length) {
      return { ok: false, message: 'Невалидна карта от масата.' };
    }

    const selectedTableSums = possibleSums(selectedTableCards);
    const canCapture = cardValues(handCard).some((value) => selectedTableSums.has(value));
    if (!canCapture) {
      return { ok: false, message: 'Невалидна комбинация.' };
    }

    const selectedTableCardIds = tableCardIds.map(Number);
    player.hand = player.hand.filter((card) => card.id !== handCard.id);
    this.table = this.table.filter((card) => !selectedTableCardIds.includes(card.id));
    player.captured.push(handCard, ...selectedTableCards);
    this.lastCapturingPlayer = playerId;

    const capturedLabels = selectedTableCards.map((card) => card.label).join(' + ');
    const actionMessage = `Player ${playerId} взе ${capturedLabels} с ${handCard.label}`;
    const action = {
      id: this.nextActionId(),
      playerId,
      type: 'capture',
      playedCard: handCard,
      capturedCards: selectedTableCards,
      message: actionMessage,
      tabla: false,
      extraMessages: []
    };

    if (this.table.length === 0) {
      player.tabli += 1;
      action.type = 'tabla';
      action.tabla = true;
      action.message = `${actionMessage}. Табла! +1 точка`;
      this.message = `Player ${playerId} направи табла!`;
    } else {
      this.message = actionMessage;
    }

    this.addHistory(action.message);
    this.lastAction = action;
    this.afterMove(action);
    return { ok: true };
  }

  throwCard(playerId, handCardId) {
    const guard = this.validateTurn(playerId, handCardId);
    if (!guard.ok) return guard;

    const player = this.players[playerId];
    const handCard = player.hand.find((card) => card.id === Number(handCardId));

    player.hand = player.hand.filter((card) => card.id !== handCard.id);
    this.table.push(handCard);
    const action = {
      id: this.nextActionId(),
      playerId,
      type: 'throw',
      playedCard: handCard,
      capturedCards: [],
      message: `Player ${playerId} хвърли ${handCard.label}`,
      tabla: false,
      extraMessages: []
    };
    this.message = action.message;

    this.addHistory(action.message);
    this.lastAction = action;
    this.afterMove(action);
    return { ok: true };
  }

  validateTurn(playerId, handCardId) {
    if (this.status !== 'playing') {
      return { ok: false, message: 'Играта още не е започнала.' };
    }

    if (playerId !== this.currentPlayer) {
      return { ok: false, message: 'Не си на ход.' };
    }

    if (!handCardId || !this.players[playerId].hand.some((card) => card.id === Number(handCardId))) {
      return { ok: false, message: 'Избери валидна карта от ръката си.' };
    }

    return { ok: true };
  }

  afterMove(action = null) {
    if (this.players[1].hand.length === 0 && this.players[2].hand.length === 0) {
      if (this.deck.length >= 2) {
        this.dealHands();
        this.message += ' Ново раздаване.';
        this.addHistory('Раздадени са нови карти.');
        if (action) action.extraMessages.push('Раздадени са нови карти.');
      } else {
        this.finish();
        if (action) action.extraMessages.push('Играта приключи.');
        return;
      }
    }

    this.currentPlayer = this.currentPlayer === 1 ? 2 : 1;
  }

  finish() {
    if (this.lastCapturingPlayer && this.table.length > 0) {
      this.players[this.lastCapturingPlayer].captured.push(...this.table);
      this.table = [];
    }

    this.calculateScores();
    this.finalResult = this.getFinalResult();
    this.status = 'finished';
    this.message = this.finalResult.winner
      ? `Player ${this.finalResult.winner} спечели!`
      : 'Равен резултат!';
    this.addHistory('Играта приключи.');
  }

  calculateScores() {
    const cardCounts = {
      1: this.players[1].captured.length,
      2: this.players[2].captured.length
    };

    for (const playerId of [1, 2]) {
      this.players[playerId].score =
        scoreCapturedCards(this.players[playerId].captured) + this.players[playerId].tabli;
    }

    if (cardCounts[1] > cardCounts[2]) this.players[1].score += 3;
    if (cardCounts[2] > cardCounts[1]) this.players[2].score += 3;
  }

  getStateForPlayer(playerId) {
    const publicPlayers = {
      1: this.publicPlayerState(1),
      2: this.publicPlayerState(2)
    };

    return {
      status: this.status,
      playerId,
      currentPlayer: this.currentPlayer,
      deckCount: this.deck.length,
      table: this.table,
      hand: playerId ? this.players[playerId].hand : [],
      players: publicPlayers,
      lastAction: this.lastAction,
      finalResult: this.finalResult,
      history: this.history,
      message: this.message
    };
  }

  publicPlayerState(playerId) {
    const player = this.players[playerId];
    return {
      handCount: player.hand.length,
      capturedCount: player.captured.length,
      tabli: player.tabli,
      score: player.score
    };
  }

  nextActionId() {
    this.actionId += 1;
    return this.actionId;
  }

  addHistory(text) {
    this.history.unshift({ id: this.nextActionId(), text });
    this.history = this.history.slice(0, 10);
  }

  getFinalResult() {
    const score1 = this.players[1].score;
    const score2 = this.players[2].score;
    return {
      winner: score1 > score2 ? 1 : score2 > score1 ? 2 : null,
      scores: { 1: score1, 2: score2 }
    };
  }
}

module.exports = { Game };
