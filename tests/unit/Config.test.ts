import { describe, it, expect } from 'vitest';
import { detectTmuxPath, detectClaudePath } from '../../src/core/Config.js';

describe('Config', () => {
  describe('detectTmuxPath', () => {
    it('finds tmux on this system', () => {
      const tmuxPath = detectTmuxPath();
      // tmux should be installed on the dev machine
      expect(tmuxPath).toBeTruthy();
      expect(tmuxPath).toContain('tmux');
    });
  });

  describe('detectClaudePath', () => {
    it('finds Claude CLI on this system', () => {
      const claudePath = detectClaudePath();
      // Claude CLI should be installed on the dev machine
      expect(claudePath).toBeTruthy();
      expect(claudePath).toContain('claude');
    });
  });
});
