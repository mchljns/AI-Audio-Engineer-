// Planning Center Services: read upcoming plans (songs in order, and who's on which position).
//
// Uses a Personal Access Token (an app ID and secret), created by a Planning Center admin at
// https://api.planningcenteronline.com/oauth/applications → Personal Access Tokens.
// The token is stored only on the booth Mac and never sent to iPads.
// Read-only: Mix Assistant never changes anything in Planning Center.

import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://api.planningcenteronline.com';

export class PlanningCenter {
  constructor({ file, baseUrl = BASE, fetchImpl = (...a) => fetch(...a) } = {}) {
    this.file = file;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.creds = null;
    try {
      this.creds = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* not set up yet */
    }
    this.state = { busy: false, error: null, serviceTypes: [], plans: [], plansFor: null, lastSync: null };
  }

  get configured() {
    return !!(this.creds?.appId && this.creds?.secret);
  }

  saveToken(appId, secret) {
    const a = String(appId ?? '').trim();
    const s = String(secret ?? '').trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(a) || !/^[A-Za-z0-9_-]{8,128}$/.test(s)) throw new Error("That doesn't look like a Planning Center app ID and secret.");
    this.creds = { appId: a, secret: s };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.creds), { mode: 0o600 });
  }

  forget() {
    this.creds = null;
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* already gone */
    }
    this.state = { ...this.state, serviceTypes: [], plans: [], plansFor: null };
  }

  async #get(pathAndQuery) {
    if (!this.configured) throw new Error('Planning Center isn\'t set up yet: add the token on the booth Mac.');
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${pathAndQuery}`, {
        headers: { authorization: `Basic ${Buffer.from(`${this.creds.appId}:${this.creds.secret}`).toString('base64')}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error("Couldn't reach Planning Center. Is the Mac on the internet? (The mixer's own Wi-Fi has none: sync before you connect to it.)");
    }
    if (res.status === 401 || res.status === 403) throw new Error("Planning Center didn't accept the token. Check the app ID and secret, and that the token's owner can see Services.");
    if (res.status === 429) throw new Error('Planning Center asked us to slow down. Try again in a minute.');
    if (!res.ok) throw new Error(`Planning Center answered with an error (${res.status}).`);
    return res.json();
  }

  async #run(fn) {
    this.state.busy = true;
    this.state.error = null;
    try {
      return await fn();
    } catch (err) {
      this.state.error = err.message;
      throw err;
    } finally {
      this.state.busy = false;
    }
  }

  serviceTypes() {
    return this.#run(async () => {
      const j = await this.#get('/services/v2/service_types?per_page=50');
      this.state.serviceTypes = (j.data ?? []).map((d) => ({ id: String(d.id), name: String(d.attributes?.name ?? 'Service') }));
      return this.state.serviceTypes;
    });
  }

  upcomingPlans(serviceTypeId) {
    return this.#run(async () => {
      const st = encodeURIComponent(String(serviceTypeId));
      const j = await this.#get(`/services/v2/service_types/${st}/plans?filter=future&order=sort_date&per_page=8`);
      this.state.plans = (j.data ?? []).map((d) => ({
        id: String(d.id),
        title: String(d.attributes?.title || d.attributes?.series_title || 'Service'),
        dates: String(d.attributes?.dates ?? ''),
        sortDate: String(d.attributes?.sort_date ?? ''),
      }));
      this.state.plansFor = String(serviceTypeId);
      return this.state.plans;
    });
  }

  /** Songs in order and the team, for one plan. */
  plan(serviceTypeId, planId) {
    return this.#run(async () => {
      const st = encodeURIComponent(String(serviceTypeId));
      const p = encodeURIComponent(String(planId));
      const [planJ, itemsJ, teamJ] = await Promise.all([
        this.#get(`/services/v2/service_types/${st}/plans/${p}`),
        this.#get(`/services/v2/service_types/${st}/plans/${p}/items?per_page=100&include=arrangement`),
        this.#get(`/services/v2/service_types/${st}/plans/${p}/team_members?per_page=100`),
      ]);
      const items = (itemsJ.data ?? [])
        .filter((d) => d.attributes?.item_type === 'song')
        .sort((a, b) => (a.attributes?.sequence ?? 0) - (b.attributes?.sequence ?? 0))
        .map((d) => {
          // Tempo lives on the song's arrangement, when the team has filled it in.
          const arr = d.relationships?.arrangement?.data?.id;
          const bpm = Number((itemsJ.included ?? []).find((x) => x.type === 'Arrangement' && x.id === arr)?.attributes?.bpm);
          return { title: String(d.attributes?.title ?? 'Song'), key: String(d.attributes?.key_name ?? ''), songId: d.relationships?.song?.data?.id ? String(d.relationships.song.data.id) : null, bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null };
        });
      const team = (teamJ.data ?? []).map((d) => ({
        name: String(d.attributes?.name ?? 'Someone'),
        position: String(d.attributes?.team_position_name ?? ''),
        status: String(d.attributes?.status ?? ''),
        personId: d.relationships?.person?.data?.id ? String(d.relationships.person.data.id) : null,
      }));
      const a = planJ.data?.attributes ?? {};
      this.state.lastSync = new Date().toISOString();
      return { title: String(a.title || a.series_title || 'Service'), date: String(a.dates ?? ''), serviceTypeId: String(serviceTypeId), planId: String(planId), songs: items, team };
    });
  }

  status() {
    return { configured: this.configured, ...this.state };
  }
}
