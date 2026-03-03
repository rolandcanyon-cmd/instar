/**
 * TopicContentValidator — test suite for Instar's configurable content validation.
 *
 * Covers: configurable content classification, topic purpose validation,
 * purpose compatibility, bypass/permissive behavior, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyContent,
  validateTopicContent,
  type ContentValidationConfig,
  type CategoryKeywords,
} from '../../src/messaging/TopicContentValidator.js';

// ─── Test Fixtures ──────────────────────────────────────────────────

/** Example categories for a customer service agent */
const TEST_CATEGORIES: Record<string, CategoryKeywords> = {
  billing: {
    primary: [
      'invoice', 'payment failed', 'billing issue',
      'refund request', 'charge dispute',
    ],
    secondary: [
      'subscription', 'account balance', 'credit card',
      'payment method',
    ],
  },
  technical: {
    primary: [
      'error message', 'crash report', 'bug found',
      'stack trace', 'production error',
    ],
    secondary: [
      'deploy', 'build failure', 'timeout',
      'server error',
    ],
  },
  sales: {
    primary: [
      'new lead', 'demo request', 'pricing inquiry',
      'enterprise plan',
    ],
    secondary: [
      'prospect', 'pipeline', 'conversion',
      'onboarding',
    ],
  },
  support: {
    primary: [
      'password reset', 'can\'t log in', 'support ticket',
      'help request',
    ],
    secondary: [
      'user complaint', 'access issue', 'login problem',
    ],
  },
};

const TEST_CONFIG: ContentValidationConfig = {
  enabled: true,
  categories: TEST_CATEGORIES,
  topicPurposes: {
    '100': 'billing',
    '200': 'technical',
    '300': 'sales',
    '400': 'support',
    '500': 'general',
  },
  compatibility: {
    billing: ['billing', 'support'],
    technical: ['technical'],
    sales: ['sales'],
    support: ['support', 'billing'],
    general: [],
  },
};

// ─── Content Classification Tests ───────────────────────────────────

describe('classifyContent', () => {
  it('classifies billing content with high confidence', () => {
    const result = classifyContent(
      'Invoice #1234 has a payment failed error. Customer wants a refund request processed.',
      TEST_CATEGORIES,
    );
    expect(result.category).toBe('billing');
    expect(result.confidence).toBe('high');
    expect(result.matchedKeywords.length).toBeGreaterThan(0);
  });

  it('classifies technical content with high confidence', () => {
    const result = classifyContent(
      'Crash report from production: stack trace shows null pointer in auth module.',
      TEST_CATEGORIES,
    );
    expect(result.category).toBe('technical');
    expect(result.confidence).toBe('high');
  });

  it('classifies sales content with high confidence', () => {
    const result = classifyContent(
      'New lead from website: demo request for enterprise plan.',
      TEST_CATEGORIES,
    );
    expect(result.category).toBe('sales');
    expect(result.confidence).toBe('high');
  });

  it('classifies support content with high confidence', () => {
    const result = classifyContent(
      'Support ticket: user can\'t log in after password reset.',
      TEST_CATEGORIES,
    );
    expect(result.category).toBe('support');
    expect(result.confidence).toBe('high');
  });

  it('returns null category for generic/unclassifiable content', () => {
    const result = classifyContent(
      'The weather is nice today. I had a great lunch.',
      TEST_CATEGORIES,
    );
    expect(result.category).toBeNull();
    expect(result.confidence).toBe('low');
  });

  it('returns null category for short ambiguous messages', () => {
    const result = classifyContent('Done.', TEST_CATEGORIES);
    expect(result.category).toBeNull();
  });

  it('classifies by secondary keywords when 2+ match', () => {
    const result = classifyContent(
      'The subscription account balance shows a credit card issue with the payment method.',
      TEST_CATEGORIES,
    );
    expect(result.category).toBe('billing');
    expect(result.confidence).toBe('moderate');
  });

  it('handles empty string gracefully', () => {
    const result = classifyContent('', TEST_CATEGORIES);
    expect(result.category).toBeNull();
    expect(result.confidence).toBe('low');
    expect(result.matchedKeywords).toEqual([]);
  });

  it('is case-insensitive', () => {
    const result = classifyContent(
      'INVOICE #999 PAYMENT FAILED — REFUND REQUEST pending.',
      TEST_CATEGORIES,
    );
    expect(result.category).toBe('billing');
    expect(result.confidence).toBe('high');
  });

  it('picks the strongest category when content spans multiple domains', () => {
    const result = classifyContent(
      'Support ticket about billing issue: invoice shows payment failed, wants refund request. Can\'t log in either.',
      TEST_CATEGORIES,
    );
    // Billing should win with 3 primary matches vs support's 2
    expect(result.category).toBe('billing');
    expect(result.confidence).toBe('high');
  });

  it('handles empty categories gracefully', () => {
    const result = classifyContent('Invoice payment failed', {});
    expect(result.category).toBeNull();
    expect(result.confidence).toBe('low');
  });
});

// ─── Topic Content Validation Tests ─────────────────────────────────

describe('validateTopicContent', () => {
  describe('permissive behavior', () => {
    it('allows any content when topic has no declared purpose', () => {
      const result = validateTopicContent(
        'Invoice payment failed for customer',
        null,
        TEST_CONFIG,
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeNull();
    });

    it('allows any content for "general" purpose topics', () => {
      const result = validateTopicContent(
        'Invoice payment failed for customer',
        'general',
        TEST_CONFIG,
      );
      expect(result.allowed).toBe(true);
    });

    it('allows any content for "interface" purpose topics', () => {
      const result = validateTopicContent(
        'Crash report from production',
        'interface',
        TEST_CONFIG,
      );
      expect(result.allowed).toBe(true);
    });

    it('allows unclassifiable content regardless of topic purpose', () => {
      const result = validateTopicContent(
        'The weather is nice today.',
        'billing',
        TEST_CONFIG,
      );
      expect(result.allowed).toBe(true);
      expect(result.detectedCategory).toBeNull();
    });
  });

  describe('bypass behavior', () => {
    it('allows any content when bypass flag is set', () => {
      const result = validateTopicContent(
        'Invoice payment failed for customer',
        'technical',
        TEST_CONFIG,
        { bypass: true },
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('matching content', () => {
    it('allows billing content in billing topic', () => {
      const result = validateTopicContent(
        'Invoice #1234 payment failed. Customer wants a refund request.',
        'billing',
        TEST_CONFIG,
      );
      expect(result.allowed).toBe(true);
      expect(result.detectedCategory).toBe('billing');
    });

    it('allows technical content in technical topic', () => {
      const result = validateTopicContent(
        'Crash report: stack trace shows error in auth module.',
        'technical',
        TEST_CONFIG,
      );
      expect(result.allowed).toBe(true);
      expect(result.detectedCategory).toBe('technical');
    });

    it('allows sales content in sales topic', () => {
      const result = validateTopicContent(
        'New lead: demo request for enterprise plan evaluation.',
        'sales',
        TEST_CONFIG,
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('compatible purposes', () => {
    it('allows support content in billing topic (compatible)', () => {
      const result = validateTopicContent(
        'Support ticket: user can\'t log in after password reset.',
        'billing',
        TEST_CONFIG,
      );
      expect(result.allowed).toBe(true);
      expect(result.detectedCategory).toBe('support');
    });

    it('allows billing content in support topic (compatible)', () => {
      const result = validateTopicContent(
        'Invoice payment failed — billing issue with the customer account.',
        'support',
        TEST_CONFIG,
      );
      expect(result.allowed).toBe(true);
      expect(result.detectedCategory).toBe('billing');
    });
  });

  describe('mismatched content (rejection)', () => {
    it('rejects billing content in technical topic', () => {
      const result = validateTopicContent(
        'Invoice #1234 payment failed. Customer wants a refund request.',
        'technical',
        TEST_CONFIG,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('billing');
      expect(result.reason).toContain('technical');
      expect(result.detectedCategory).toBe('billing');
      expect(result.topicPurpose).toBe('technical');
      expect(result.suggestion).toBeTruthy();
    });

    it('rejects technical content in sales topic', () => {
      const result = validateTopicContent(
        'Crash report from production: stack trace shows critical error.',
        'sales',
        TEST_CONFIG,
      );
      expect(result.allowed).toBe(false);
      expect(result.detectedCategory).toBe('technical');
    });

    it('rejects sales content in technical topic', () => {
      const result = validateTopicContent(
        'New lead from website. Demo request for enterprise plan.',
        'technical',
        TEST_CONFIG,
      );
      expect(result.allowed).toBe(false);
      expect(result.detectedCategory).toBe('sales');
    });

    it('includes helpful suggestion in rejection', () => {
      const result = validateTopicContent(
        'Invoice payment failed for customer account.',
        'technical',
        TEST_CONFIG,
      );
      expect(result.allowed).toBe(false);
      expect(result.suggestion).toBeTruthy();
      expect(result.suggestion).toContain('billing');
    });

    it('includes matched keywords in rejection reason', () => {
      const result = validateTopicContent(
        'Invoice payment failed and refund request needed.',
        'sales',
        TEST_CONFIG,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeTruthy();
      expect(result.reason!.toLowerCase()).toContain('billing');
    });
  });

  describe('disabled validation', () => {
    it('allows everything when validation is disabled', () => {
      const disabledConfig: ContentValidationConfig = {
        ...TEST_CONFIG,
        enabled: false,
      };
      // Note: validateTopicContent itself doesn't check enabled —
      // that's the adapter's job. The validator always validates when called.
      // This test confirms the validator works regardless.
      const result = validateTopicContent(
        'Invoice payment failed',
        'technical',
        disabledConfig,
      );
      expect(result.allowed).toBe(false); // Validator rejects; adapter gates on 'enabled'
    });
  });
});

// ─── Category Configuration Tests ───────────────────────────────────

describe('configurable categories', () => {
  it('works with completely custom categories', () => {
    const customCategories: Record<string, CategoryKeywords> = {
      recipes: {
        primary: ['ingredients', 'cooking time', 'preheat oven'],
        secondary: ['tablespoon', 'cup of', 'stir'],
      },
      gardening: {
        primary: ['plant seeds', 'watering schedule', 'soil ph'],
        secondary: ['fertilizer', 'pruning', 'sunlight'],
      },
    };

    const result = classifyContent(
      'Preheat oven to 350. Mix ingredients. Cooking time: 30 minutes.',
      customCategories,
    );
    expect(result.category).toBe('recipes');
    expect(result.confidence).toBe('high');
  });

  it('validates custom categories against custom purposes', () => {
    const customConfig: ContentValidationConfig = {
      enabled: true,
      categories: {
        recipes: {
          primary: ['ingredients', 'cooking time'],
          secondary: ['tablespoon', 'cup of'],
        },
        gardening: {
          primary: ['plant seeds', 'watering schedule'],
          secondary: ['fertilizer', 'pruning'],
        },
      },
      topicPurposes: { '1': 'recipes', '2': 'gardening' },
      compatibility: { recipes: ['recipes'], gardening: ['gardening'] },
    };

    // Recipes in gardening topic → rejected
    const result = validateTopicContent(
      'Mix ingredients, set cooking time to 45 minutes.',
      'gardening',
      customConfig,
    );
    expect(result.allowed).toBe(false);
    expect(result.detectedCategory).toBe('recipes');
  });

  it('handles categories with only primary keywords', () => {
    const categories: Record<string, CategoryKeywords> = {
      alerts: {
        primary: ['CRITICAL ALERT', 'system down'],
        secondary: [],
      },
    };
    const result = classifyContent('CRITICAL ALERT: system down!', categories);
    expect(result.category).toBe('alerts');
    expect(result.confidence).toBe('high');
  });

  it('handles categories with only secondary keywords (needs 2+)', () => {
    const categories: Record<string, CategoryKeywords> = {
      monitoring: {
        primary: [],
        secondary: ['cpu usage', 'memory', 'disk space', 'latency'],
      },
    };

    // Single secondary keyword → not enough
    const result1 = classifyContent('Check cpu usage', categories);
    expect(result1.category).toBeNull();

    // Two secondary keywords → moderate confidence
    const result2 = classifyContent('Check cpu usage and memory levels', categories);
    expect(result2.category).toBe('monitoring');
    expect(result2.confidence).toBe('moderate');
  });
});
