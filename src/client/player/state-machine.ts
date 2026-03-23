export type PlayerState =
  | 'IDLE' | 'LOADING_MANIFEST' | 'LOADING_INIT_SEGMENT'
  | 'BUFFERING' | 'PLAYING' | 'REBUFFERING' | 'ENDED' | 'ERROR';

const VALID_TRANSITIONS: Record<PlayerState, PlayerState[]> = {
  IDLE: ['LOADING_MANIFEST', 'ERROR'],
  LOADING_MANIFEST: ['LOADING_INIT_SEGMENT', 'ERROR'],
  LOADING_INIT_SEGMENT: ['BUFFERING', 'ERROR'],
  BUFFERING: ['PLAYING', 'ERROR'],
  PLAYING: ['REBUFFERING', 'ENDED', 'LOADING_INIT_SEGMENT', 'ERROR'],
  REBUFFERING: ['PLAYING', 'BUFFERING', 'ERROR'],
  ENDED: ['IDLE'],
  ERROR: ['IDLE'],
};

type TransitionListener = (from: PlayerState, to: PlayerState) => void;

export class PlayerStateMachine {
  private _state: PlayerState = 'IDLE';
  private listeners: TransitionListener[] = [];

  get state(): PlayerState {
    return this._state;
  }

  transition(to: PlayerState): boolean {
    const allowed = VALID_TRANSITIONS[this._state];
    if (!allowed.includes(to)) {
      return false;
    }
    const from = this._state;
    this._state = to;
    for (const listener of this.listeners) {
      listener(from, to);
    }
    return true;
  }

  onTransition(listener: TransitionListener): void {
    this.listeners.push(listener);
  }
}
