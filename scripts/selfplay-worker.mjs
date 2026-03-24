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
  chooseAiAction,
  createGameReducer,
  getAiPendingActions,
  initialState,
} = engine;

const reducer = createGameReducer(effects);

const stableClone = (value) => structuredClone(value);

const resolveAiPendingAction = (state, dispatch, policy) => {
  getAiPendingActions(state, policy, 'player').forEach((action) => dispatch(action));
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
    dispatch(chooseAiAction(state, state.priority, 'hard', state.priority === 'player' ? playerPolicy : aiPolicy));
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
