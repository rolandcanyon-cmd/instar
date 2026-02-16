/**
 * User Manager — multi-user identity resolution.
 *
 * Maps incoming messages to known users based on their channels.
 * Same agent, same repo, different relationship per user.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { UserProfile, UserChannel, Message } from '../core/types.js';

export class UserManager {
  private users: Map<string, UserProfile> = new Map();
  private channelIndex: Map<string, string> = new Map(); // "type:identifier" -> userId
  private usersFile: string;

  constructor(stateDir: string, initialUsers?: UserProfile[]) {
    this.usersFile = path.join(stateDir, 'users.json');
    this.loadUsers(initialUsers);
  }

  /**
   * Resolve a user from an incoming message.
   * Returns the user profile if the sender is recognized.
   */
  resolveFromMessage(message: Message): UserProfile | null {
    return this.resolveFromChannel(message.channel);
  }

  /**
   * Resolve a user from a channel identifier.
   */
  resolveFromChannel(channel: UserChannel): UserProfile | null {
    const key = `${channel.type}:${channel.identifier}`;
    const userId = this.channelIndex.get(key);
    if (!userId) return null;
    return this.users.get(userId) || null;
  }

  /**
   * Get a user by ID.
   */
  getUser(userId: string): UserProfile | null {
    return this.users.get(userId) || null;
  }

  /**
   * List all registered users.
   */
  listUsers(): UserProfile[] {
    return Array.from(this.users.values());
  }

  /**
   * Add or update a user.
   */
  upsertUser(profile: UserProfile): void {
    // Remove old channel index entries
    const existing = this.users.get(profile.id);
    if (existing) {
      for (const channel of existing.channels) {
        this.channelIndex.delete(`${channel.type}:${channel.identifier}`);
      }
    }

    // Add new entries
    this.users.set(profile.id, profile);
    for (const channel of profile.channels) {
      this.channelIndex.set(`${channel.type}:${channel.identifier}`, profile.id);
    }

    this.persistUsers();
  }

  /**
   * Remove a user.
   */
  removeUser(userId: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;

    for (const channel of user.channels) {
      this.channelIndex.delete(`${channel.type}:${channel.identifier}`);
    }
    this.users.delete(userId);
    this.persistUsers();
    return true;
  }

  /**
   * Check if a user has a specific permission.
   */
  hasPermission(userId: string, permission: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;
    return user.permissions.includes(permission) || user.permissions.includes('admin');
  }

  private loadUsers(initialUsers?: UserProfile[]): void {
    // Load from file if exists
    if (fs.existsSync(this.usersFile)) {
      const data: UserProfile[] = JSON.parse(fs.readFileSync(this.usersFile, 'utf-8'));
      for (const user of data) {
        this.users.set(user.id, user);
        for (const channel of user.channels) {
          this.channelIndex.set(`${channel.type}:${channel.identifier}`, user.id);
        }
      }
    }

    // Merge initial users (config takes precedence for initial setup)
    if (initialUsers) {
      for (const user of initialUsers) {
        if (!this.users.has(user.id)) {
          this.upsertUser(user);
        }
      }
    }
  }

  private persistUsers(): void {
    const dir = path.dirname(this.usersFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      this.usersFile,
      JSON.stringify(Array.from(this.users.values()), null, 2)
    );
  }
}
