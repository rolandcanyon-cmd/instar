/**
 * MoltBridge HTTP routes — Server endpoints for MoltBridge integration.
 *
 * Spec Section 3.8:
 * - POST /moltbridge/register — Register agent with MoltBridge
 * - POST /moltbridge/discover — Capability/broker discovery
 * - GET /moltbridge/trust/:agentId — Get IQS band (cached)
 * - POST /moltbridge/attest — Submit peer attestation
 * - GET /moltbridge/status — Registration + balance
 */

import { Router, type Request, type Response } from 'express';
import type { MoltBridgeClient } from './MoltBridgeClient.js';
import type { CanonicalIdentityManager } from '../identity/IdentityManager.js';

export interface MoltBridgeRouteDeps {
  client: MoltBridgeClient;
  identity: CanonicalIdentityManager;
}

export function createMoltBridgeRoutes(deps: MoltBridgeRouteDeps): Router {
  const router = Router();
  const { client, identity } = deps;

  // POST /moltbridge/register
  router.post('/moltbridge/register', async (req: Request, res: Response) => {
    try {
      const id = identity.get();
      if (!id) {
        res.status(500).json({ error: 'No canonical identity available' });
        return;
      }

      const result = await client.register(
        id.canonicalId,
        id.publicKey,
        req.body.capabilities ?? [],
        req.body.displayName,
      );
      res.json(result);
    } catch (err) {
      res.status(502).json({
        error: { code: 'MOLTBRIDGE_UNAVAILABLE', message: String(err) },
      });
    }
  });

  // POST /moltbridge/discover
  router.post('/moltbridge/discover', async (req: Request, res: Response) => {
    try {
      const { capability, limit } = req.body;
      if (!capability) {
        res.status(400).json({ error: 'capability is required' });
        return;
      }
      const result = await client.discover(capability, limit);
      res.json(result);
    } catch (err) {
      res.status(502).json({
        error: { code: 'MOLTBRIDGE_DISCOVERY_FAILED', message: String(err) },
      });
    }
  });

  // GET /moltbridge/trust/:agentId
  router.get('/moltbridge/trust/:agentId', async (req: Request, res: Response) => {
    try {
      const band = await client.getIQSBand(req.params.agentId);
      res.json({ agentId: req.params.agentId, iqsBand: band ?? 'unknown' });
    } catch (err) {
      res.status(502).json({
        error: { code: 'MOLTBRIDGE_TRUST_QUERY_FAILED', message: String(err) },
      });
    }
  });

  // POST /moltbridge/attest
  router.post('/moltbridge/attest', async (req: Request, res: Response) => {
    try {
      const { subject, capability, outcome, confidence, context } = req.body;
      if (!subject || !capability || !outcome) {
        res.status(400).json({ error: 'subject, capability, and outcome are required' });
        return;
      }

      const id = identity.get();
      if (!id) {
        res.status(500).json({ error: 'No canonical identity available' });
        return;
      }

      await client.submitAttestation({
        attestor: id.displayFingerprint,
        subject,
        capability,
        outcome,
        confidence: confidence ?? 0.8,
        context: context ?? 'direct-interaction',
      });
      res.json({ submitted: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Invalid capability')) {
        res.status(400).json({ error: { code: 'INVALID_CAPABILITY_TAG', message } });
      } else {
        res.status(502).json({
          error: { code: 'MOLTBRIDGE_ATTESTATION_FAILED', message },
        });
      }
    }
  });

  // GET /moltbridge/status
  router.get('/moltbridge/status', async (req: Request, res: Response) => {
    try {
      const id = identity.get();
      if (!id) {
        res.json({ registered: false, reason: 'No canonical identity' });
        return;
      }

      if (!client.enabled) {
        res.json({ registered: false, reason: 'MoltBridge disabled in config' });
        return;
      }

      const status = await client.getStatus(id.canonicalId);
      res.json(status);
    } catch (err) {
      res.status(502).json({
        error: { code: 'MOLTBRIDGE_STATUS_FAILED', message: String(err) },
      });
    }
  });

  return router;
}
