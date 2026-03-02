/**
 * Confluence REST API client.
 * Handles both Confluence Cloud (Basic Auth: email + API token)
 * and Confluence Data Center / Server (Bearer Auth: PAT).
 */

import * as core from '@actions/core';
import { ConfluencePage } from './types';

export class ConfluenceClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(
    baseUrl: string,
    type: 'cloud' | 'datacenter',
    token: string,
    user?: string
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');

    if (type === 'cloud') {
      if (!user) throw new Error('confluence_user is required for Confluence Cloud');
      const encoded = Buffer.from(`${user}:${token}`).toString('base64');
      this.authHeader = `Basic ${encoded}`;
    } else {
      this.authHeader = `Bearer ${token}`;
    }

    //Mask the token in all log output
    core.setSecret(token);
  }

  //Private helpers

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}/rest/api${path}`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Atlassian-Token': 'no-check',
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Confluence API ${method} ${url} -> ${res.status} ${res.statusText}: ${text}`
      );
    }

    //204 No Content
    if (res.status === 204) return undefined as T;

    return res.json() as Promise<T>;
  }

  //Public API

  /**
   * Fetch a Confluence page including its storage-format body and current version.
   */
  async getPage(pageId: string): Promise<ConfluencePage> {
    const data = await this.request<{
      id: string;
      title: string;
      version: { number: number };
      body: { storage: { value: string } };
      _links: { base: string; webui: string };
    }>('GET', `/content/${pageId}?expand=body.storage,version`);

    return {
      id: data.id,
      title: data.title,
      storageBody: data.body.storage.value,
      version: data.version.number,
      webUrl: `${data._links.base}${data._links.webui}`,
    };
  }

  /**
   * Update a Confluence page with new storage-format body.
   * Re-fetches the page first to get the absolute latest version number
   * so concurrent updates don't clobber each other.
   */
  async updatePage(
    pageId: string,
    title: string,
    newStorageBody: string,
    comment = 'Updated by confluence-pr-sync-agent'
  ): Promise<ConfluencePage> {
    //Always re-fetch to get the latest version
    const current = await this.getPage(pageId);
    const nextVersion = current.version + 1;

    core.info(
      `Updating Confluence page ${pageId} "${title}" -> version ${nextVersion}`
    );

    await this.request('PUT', `/content/${pageId}`, {
      version: { number: nextVersion },
      title,
      type: 'page',
      body: {
        storage: {
          value: newStorageBody,
          representation: 'storage',
        },
      },
      message: comment,
    });

    //Return updated page
    return this.getPage(pageId);
  }
}
