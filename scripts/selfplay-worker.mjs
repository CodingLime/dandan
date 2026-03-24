import { parentPort, workerData } from 'node:worker_threads';

const {
  runtimeDir,
  candidate,
  benchmarks,
  gamesPerSeat,
  maxSteps
} = workerData;

const effects = {
  initAudio() {},
  playDraw() {},
  playLand() {},
  playCast() {},
  playResolve() {},
  playPhase() {}
};

const engine = await import(new URL('./game/engine.js', `file:///${runtimeDir.replace(/\\/g, '/')}/`));
const {
  DANDAN_NAME,
  controlsIsland,
  createGameReducer,
  initialState,
  isCastable
} = engine;

const reducer = createGameReducer(effects);

const randomChoice = (list) => list[Math.floor(Math.random() * list.length)];
const stableClone = (value) => structuredClone(value);

const shouldMakeMistake = (baseRate, policy) => Math.random() < Math.max(baseRate, policy.mistakeRate ?? 0.02);

const getSpellPriority = (card, policy) => {
  switch (card.name) {
    case DANDAN_NAME: return 8 + policy.aggression * 4;
    case 'Control Magic': return 6 + policy.control * 4;
    case 'Memory Lapse':
    case 'Unsubstantiate': return 5 + policy.counterBias * 3;
    case 'Capture of Jingzhou': return 5 + policy.control * 2;
    case "Day's Undoing": return 4 + policy.drawBias * 2;
    case 'Accumulated Knowledge':
    case 'Predict':
    case 'Telling Time':
    case 'Brainstorm':
    case 'Chart a Course':
    case 'Mental Note':
      return 2 + policy.drawBias * 3;
    default:
      return 1;
  }
};

const pickPendingCards = (hand, count, policy) => {
  const preferKeepingLands = hand.filter((card) => card.isLand).length < Math.ceil(policy.landLimit ?? 4);
  return [...hand]
    .sort((a, b) => {
      const aScore = (a.isLand ? (preferKeepingLands ? 8 : -4) : 0) - a.cost * (policy.control > policy.aggression ? 0.6 : 0.2);
      const bScore = (b.isLand ? (preferKeepingLands ? 8 : -4) : 0) - b.cost * (policy.control > policy.aggression ? 0.6 : 0.2);
      return aScore - bScore;
    })
    .slice(0, count)
    .map((card) => card.id);
};

const resolveAiPendingAction = (state, dispatch, policy) => {
  if (!state.pendingAction) return;

  if (['BRAINSTORM', 'DISCARD', 'DISCARD_CLEANUP', 'MULLIGAN_BOTTOM'].includes(state.pendingAction.type)) {
    const count = state.pendingAction.count || 0;
    const selected = pickPendingCards(state.player.hand, count, policy);
    selected.forEach((cardId) => dispatch({ type: 'TOGGLE_PENDING_SELECT', cardId }));
    dispatch({ type: 'SUBMIT_PENDING_ACTION' });
    return;
  }

  if (state.pendingAction.type === 'PREDICT') {
    dispatch({ type: 'SUBMIT_PENDING_ACTION', guess: DANDAN_NAME });
    return;
  }

  if (state.pendingAction.type === 'TELLING_TIME') {
    const ordered = [...state.pendingAction.cards].sort((a, b) => Number(b.isLand) - Number(a.isLand) || a.cost - b.cost);
    const handCard = ordered[0];
    const topCard = ordered[1];
    if (handCard) dispatch({ type: 'UPDATE_TELLING_TIME', cardId: handCard.id, dest: 'hand' });
    if (topCard) dispatch({ type: 'UPDATE_TELLING_TIME', cardId: topCard.id, dest: 'top' });
    dispatch({ type: 'SUBMIT_PENDING_ACTION' });
    return;
  }

  if (state.pendingAction.type === 'HALIMAR_DEPTHS') {
    dispatch({ type: 'SUBMIT_PENDING_ACTION' });
    return;
  }

  if (state.pendingAction.type === 'MYSTIC_SANCTUARY') {
    dispatch({ type: 'SUBMIT_PENDING_ACTION', selectedCardId: state.pendingAction.validTargets?.[0] || null });
    return;
  }

  if (state.pendingAction.type === 'ACTIVATE_LAND') {
    dispatch({ type: 'SUBMIT_PENDING_ACTION' });
  }
};

const takeAiAction = (state, dispatch, actor, policies) => {
  const policy = policies[actor];
  const opponent = actor === 'player' ? 'ai' : 'player';
  const canCast = (card) => Boolean(card) && isCastable(card, state, actor);

  if (state.stack.length > 0) {
    const topSpell = state.stack[state.stack.length - 1];
    if (topSpell.controller === opponent) {
      const lapse = state[actor].hand.find((card) => card.name === 'Memory Lapse');
      if (canCast(lapse) && topSpell.card.name === DANDAN_NAME) {
        if (policy.counterBias < 0.62 || shouldMakeMistake(0.05, policy)) {
          dispatch({ type: 'PASS_PRIORITY', player: actor });
          return;
        }
        dispatch({ type: 'CAST_SPELL', player: actor, cardId: lapse.id, target: topSpell });
        return;
      }

      const unsub = state[actor].hand.find((card) => card.name === 'Unsubstantiate');
      if (canCast(unsub) && topSpell.card.name === DANDAN_NAME) {
        if (policy.counterBias < 0.5 || shouldMakeMistake(0.08, policy)) {
          dispatch({ type: 'PASS_PRIORITY', player: actor });
          return;
        }
        dispatch({ type: 'CAST_SPELL', player: actor, cardId: unsub.id, target: topSpell });
        return;
      }
    }
    dispatch({ type: 'PASS_PRIORITY', player: actor });
    return;
  }

  if (state.turn === actor && state.phase === 'declare_attackers') {
    const defenderHasIsland = controlsIsland(state[opponent].board);
    const readyDandans = state[actor].board.filter((card) => card.name === DANDAN_NAME && !card.summoningSickness && !card.tapped && !card.attacking);
    const shouldAttack = readyDandans.length > 0
      && defenderHasIsland
      && (readyDandans.length * policy.attackBias >= Math.max(0.8, state[opponent].board.filter((card) => card.name === DANDAN_NAME).length * policy.blockBias));
    if (shouldAttack && !shouldMakeMistake(0.08, policy)) {
      dispatch({ type: 'TOGGLE_ATTACK', cardId: readyDandans[0].id, player: actor });
      return;
    }
    dispatch({ type: 'PASS_PRIORITY', player: actor });
    return;
  }

  if (state.turn === opponent && state.phase === 'declare_blockers') {
    const attackers = state[opponent].board.filter((card) => card.attacking);
    if (attackers.length > 0) {
      const hack = state[actor].hand.find((card) => ['Magical Hack', 'Crystal Spray', 'Metamorphose'].includes(card.name));
      if (!state[actor].board.some((card) => card.name === DANDAN_NAME && !card.tapped) && canCast(hack) && policy.control >= 0.5) {
        dispatch({ type: 'CAST_SPELL', player: actor, cardId: hack.id, target: attackers[0] });
        return;
      }

      const blockers = state[actor].board.filter((card) => card.name === DANDAN_NAME && !card.tapped && !card.blocking);
      if (blockers.length > 0 && policy.blockBias >= 0.52 && !shouldMakeMistake(0.1, policy)) {
        dispatch({ type: 'TOGGLE_BLOCK', cardId: blockers[0].id, player: actor });
        return;
      }
    }
    dispatch({ type: 'PASS_PRIORITY', player: actor });
    return;
  }

  if (state.turn === actor && (state.phase === 'main1' || state.phase === 'main2' || state.phase === 'upkeep')) {
    const landsInPlay = state[actor].board.filter((card) => card.isLand).length;
    const land = state[actor].hand.find((card) => card.isLand);
    if (state.phase !== 'upkeep' && land && state[actor].landsPlayed === 0 && landsInPlay < policy.landLimit) {
      dispatch({ type: 'PLAY_LAND', player: actor, cardId: land.id });
      return;
    }

    const dandan = state[actor].hand.find((card) => card.name === DANDAN_NAME);
    const opponentHasIsland = controlsIsland(state[opponent].board);
    if (state.phase !== 'upkeep' && canCast(dandan) && opponentHasIsland && !shouldMakeMistake(0.06, policy)) {
      dispatch({ type: 'CAST_SPELL', player: actor, cardId: dandan.id });
      return;
    }

    const controlMagic = state[actor].hand.find((card) => card.name === 'Control Magic');
    if (state.phase !== 'upkeep' && canCast(controlMagic) && state[opponent].board.some((card) => card.name === DANDAN_NAME) && policy.stealBias >= 0.72) {
      const target = state[opponent].board.find((card) => card.name === DANDAN_NAME);
      dispatch({ type: 'CAST_SPELL', player: actor, cardId: controlMagic.id, target });
      return;
    }

    const hack = state[actor].hand.find((card) => ['Magical Hack', 'Crystal Spray', 'Metamorphose'].includes(card.name));
    if (state.phase !== 'upkeep' && canCast(hack) && state[opponent].board.some((card) => card.name === DANDAN_NAME) && policy.control >= 0.42) {
      const target = state[opponent].board.find((card) => card.name === DANDAN_NAME);
      dispatch({ type: 'CAST_SPELL', player: actor, cardId: hack.id, target });
      return;
    }

    const castableSpells = state[actor].hand.filter((card) => !card.isLand
      && ![DANDAN_NAME, 'Memory Lapse', 'Unsubstantiate', 'Magical Hack', 'Crystal Spray', 'Control Magic', 'Metamorphose'].includes(card.name)
      && isCastable(card, state, actor));

    if (castableSpells.length > 0 && !shouldMakeMistake(0.06, policy)) {
      const spell = [...castableSpells].sort((a, b) => getSpellPriority(b, policy) - getSpellPriority(a, policy))[0] || randomChoice(castableSpells);
      dispatch({ type: 'CAST_SPELL', player: actor, cardId: spell.id });
      return;
    }
  }

  dispatch({ type: 'PASS_PRIORITY', player: actor });
};

const summarizeState = (state) => ({
  turn: state.turn,
  phase: state.phase,
  priority: state.priority,
  stackResolving: state.stackResolving,
  pendingTargetSelection: state.pendingTargetSelection,
  pendingAction: state.pendingAction?.type || null,
  player: {
    life: state.player.life,
    hand: state.player.hand.map((card) => card.name),
    board: state.player.board.map((card) => card.name)
  },
  ai: {
    life: state.ai.life,
    hand: state.ai.hand.map((card) => card.name),
    board: state.ai.board.map((card) => card.name)
  }
});

const runSingleGame = (playerPolicy, aiPolicy) => {
  let state = stableClone(initialState);
  const dispatch = (action) => {
    state = reducer(state, action);
  };

  dispatch({ type: 'START_GAME', mode: 'ai_vs_ai', difficulty: 'hard' });
  let repeatedNoOpCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (state.winner) {
      return {
        ok: true,
        winner: state.winner,
        margin: Math.abs(state.player.life - state.ai.life) + Math.abs(state.player.board.length - state.ai.board.length) * 0.2,
        steps: step
      };
    }

    if (state.pendingTargetSelection) {
      return { ok: false, winner: 'ai', reason: 'unexpected target selection', state: summarizeState(state) };
    }

    if (state.stackResolving && !state.pendingAction) {
      dispatch({ type: 'RESOLVE_TOP_STACK' });
      continue;
    }

    if (state.pendingAction) {
      const before = JSON.stringify(summarizeState(state));
      resolveAiPendingAction(state, dispatch, playerPolicy);
      repeatedNoOpCount = before === JSON.stringify(summarizeState(state)) ? repeatedNoOpCount + 1 : 0;
      if (repeatedNoOpCount >= 18) {
        return { ok: false, winner: 'ai', reason: 'pending action loop', state: summarizeState(state) };
      }
      continue;
    }

    if (!state.priority) {
      return { ok: false, winner: 'ai', reason: 'no priority', state: summarizeState(state) };
    }

    const before = JSON.stringify(summarizeState(state));
    takeAiAction(state, dispatch, state.priority, { player: playerPolicy, ai: aiPolicy });
    repeatedNoOpCount = before === JSON.stringify(summarizeState(state)) ? repeatedNoOpCount + 1 : 0;
    if (repeatedNoOpCount >= 18) {
      return { ok: false, winner: state.priority === 'player' ? 'ai' : 'player', reason: 'ai loop', state: summarizeState(state) };
    }
  }

  const playerAdvantage = (state.player.life - state.ai.life)
    + (state.player.board.length - state.ai.board.length) * 0.5
    + (state.player.hand.length - state.ai.hand.length) * 0.25;
  return {
    ok: false,
    winner: playerAdvantage >= 0 ? 'player' : 'ai',
    reason: 'step limit',
    margin: Math.abs(playerAdvantage),
    state: summarizeState(state)
  };
};

const evaluateBenchmark = (benchmark) => {
  const result = {
    name: benchmark.name,
    weight: benchmark.weight,
    games: 0,
    candidateWins: 0,
    benchmarkWins: 0,
    draws: 0,
    failures: 0,
    totalMargin: 0
  };

  for (let i = 0; i < gamesPerSeat; i++) {
    const asPlayer = runSingleGame(candidate, benchmark.weights);
    result.games += 1;
    result.totalMargin += asPlayer.margin || 0;
    if (!asPlayer.ok) result.failures += 1;
    if (asPlayer.winner === 'player') result.candidateWins += 1;
    else if (asPlayer.winner === 'ai') result.benchmarkWins += 1;
    else result.draws += 1;

    const asAi = runSingleGame(benchmark.weights, candidate);
    result.games += 1;
    result.totalMargin += asAi.margin || 0;
    if (!asAi.ok) result.failures += 1;
    if (asAi.winner === 'ai') result.candidateWins += 1;
    else if (asAi.winner === 'player') result.benchmarkWins += 1;
    else result.draws += 1;
  }

  result.winRate = result.candidateWins / Math.max(1, result.games);
  return result;
};

const benchmarkResults = benchmarks.map(evaluateBenchmark);
const aggregate = benchmarkResults.reduce((acc, benchmark) => {
  acc.games += benchmark.games;
  acc.candidateWins += benchmark.candidateWins;
  acc.benchmarkWins += benchmark.benchmarkWins;
  acc.failures += benchmark.failures;
  acc.totalMargin += benchmark.totalMargin;
  acc.weightedScore += benchmark.weight * ((benchmark.winRate - 0.5) * 1000 + benchmark.totalMargin / Math.max(1, benchmark.games) * 10 - benchmark.failures * 15);
  return acc;
}, {
  games: 0,
  candidateWins: 0,
  benchmarkWins: 0,
  failures: 0,
  totalMargin: 0,
  weightedScore: 0
});

parentPort.postMessage({
  candidate,
  aggregate: {
    ...aggregate,
    overallWinRate: aggregate.candidateWins / Math.max(1, aggregate.games)
  },
  benchmarkResults
});
