/**
 * RelayMetrics Unit Tests
 *
 * Tests counter recording, snapshot generation, rate calculation,
 * and Prometheus export format.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RelayMetrics } from '../../../../src/threadline/relay/RelayMetrics.js';

describe('RelayMetrics', () => {
  let metrics: RelayMetrics;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    metrics = new RelayMetrics(() => now);
  });

  // ── Counter Recording ────────────────────────────────────────────

  describe('counters', () => {
    it('records message events', () => {
      metrics.recordMessageRouted();
      metrics.recordMessageRouted();
      metrics.recordMessageDelivered();
      metrics.recordMessageQueued();
      metrics.recordMessageRejected();
      metrics.recordMessageExpired();

      const snap = metrics.getSnapshot();
      expect(snap.messagesRouted).toBe(2);
      expect(snap.messagesDelivered).toBe(1);
      expect(snap.messagesQueued).toBe(1);
      expect(snap.messagesRejected).toBe(1);
      expect(snap.messagesExpired).toBe(1);
    });

    it('records connection events', () => {
      metrics.recordConnection();
      metrics.recordConnection();
      metrics.recordConnection();
      metrics.recordAuthFailure();

      const snap = metrics.getSnapshot();
      expect(snap.connectionsTotal).toBe(3);
      expect(snap.authFailures).toBe(1);
    });

    it('records abuse and discovery events', () => {
      metrics.recordAbuseBan();
      metrics.recordAbuseBan();
      metrics.recordDiscoveryQuery();

      const snap = metrics.getSnapshot();
      expect(snap.abuseBansIssued).toBe(2);
      expect(snap.discoveryQueries).toBe(1);
    });

    it('records A2A events', () => {
      metrics.recordA2ARequest();
      metrics.recordA2ARequest();
      metrics.recordA2ARequestRejected();

      const snap = metrics.getSnapshot();
      expect(snap.a2aRequestsTotal).toBe(2);
      expect(snap.a2aRequestsRejected).toBe(1);
    });
  });

  // ── Gauge ────────────────────────────────────────────────────────

  describe('gauge', () => {
    it('sets active connections', () => {
      metrics.setActiveConnections(42);
      expect(metrics.getSnapshot().connectionsActive).toBe(42);

      metrics.setActiveConnections(10);
      expect(metrics.getSnapshot().connectionsActive).toBe(10);
    });
  });

  // ── Rate Calculation ─────────────────────────────────────────────

  describe('messages per minute', () => {
    it('counts messages in last 60 seconds', () => {
      // Record 5 messages "now"
      for (let i = 0; i < 5; i++) {
        metrics.recordMessageRouted();
      }
      expect(metrics.getSnapshot().messagesPerMinute).toBe(5);
    });

    it('excludes messages older than 60 seconds', () => {
      // Record 3 messages at current time
      for (let i = 0; i < 3; i++) {
        metrics.recordMessageRouted();
      }

      // Advance 61 seconds
      now += 61_000;

      // Record 2 more messages
      metrics.recordMessageRouted();
      metrics.recordMessageRouted();

      expect(metrics.getSnapshot().messagesPerMinute).toBe(2);
    });
  });

  // ── Uptime ───────────────────────────────────────────────────────

  describe('uptime', () => {
    it('reports uptime in seconds', () => {
      expect(metrics.getSnapshot().uptimeSeconds).toBe(0);

      now += 120_000; // 2 minutes
      expect(metrics.getSnapshot().uptimeSeconds).toBe(120);
    });
  });

  // ── Prometheus Export ────────────────────────────────────────────

  describe('Prometheus format', () => {
    it('exports valid Prometheus text format', () => {
      metrics.recordMessageRouted();
      metrics.recordMessageDelivered();
      metrics.setActiveConnections(5);

      const output = metrics.toPrometheus();

      // Check format
      expect(output).toContain('# HELP threadline_messages_routed_total');
      expect(output).toContain('# TYPE threadline_messages_routed_total counter');
      expect(output).toContain('threadline_messages_routed_total 1');

      expect(output).toContain('# TYPE threadline_connections_active gauge');
      expect(output).toContain('threadline_connections_active 5');

      expect(output).toContain('threadline_messages_delivered_total 1');
      expect(output).toContain('threadline_uptime_seconds 0');
    });

    it('includes all expected metrics', () => {
      const output = metrics.toPrometheus();
      const metricNames = [
        'threadline_messages_routed_total',
        'threadline_messages_delivered_total',
        'threadline_messages_queued_total',
        'threadline_messages_rejected_total',
        'threadline_messages_expired_total',
        'threadline_connections_total',
        'threadline_connections_active',
        'threadline_auth_failures_total',
        'threadline_abuse_bans_total',
        'threadline_discovery_queries_total',
        'threadline_messages_per_minute',
        'threadline_a2a_requests_total',
        'threadline_a2a_requests_rejected_total',
        'threadline_uptime_seconds',
      ];

      for (const name of metricNames) {
        expect(output).toContain(name);
      }
    });

    it('ends with newline', () => {
      expect(metrics.toPrometheus().endsWith('\n')).toBe(true);
    });
  });

  // ── Reset ────────────────────────────────────────────────────────

  describe('reset', () => {
    it('clears all counters and gauges', () => {
      metrics.recordMessageRouted();
      metrics.recordConnection();
      metrics.setActiveConnections(5);
      metrics.recordAbuseBan();

      metrics.reset();

      const snap = metrics.getSnapshot();
      expect(snap.messagesRouted).toBe(0);
      expect(snap.connectionsTotal).toBe(0);
      expect(snap.connectionsActive).toBe(0);
      expect(snap.abuseBansIssued).toBe(0);
    });
  });
});
