import { createClient } from "@supabase/supabase-js";
import type { Disk } from "./storage";
import { createVault, unlockVault, seal, open } from "./crypto";
import {
  cloudKey,
  cloudMedia,
  uuid,
  empty,
  appleNow,
  Snapshot,
  Source,
  Media,
  cloudInput,
  bounded,
  kinds,
} from "./model";
import { urlCheck } from "./network";
declare const __OXA_CLOUD_URL__: string;
declare const __OXA_CLOUD_PUBLIC_KEY__: string;
export const CLOUD_URL = __OXA_CLOUD_URL__;
export const CLOUD_KEY = __OXA_CLOUD_PUBLIC_KEY__;
export const CLOUD_CONFIGURED = !!CLOUD_URL && !!CLOUD_KEY;
export class Cloud {
  client: any;
  identity: any;
  settings: any;
  key: Buffer;
  syncing = false;
  epoch = 0;
  message = "";
  timer: any;
  lastSync: number;
  recovery = false;
  authEpoch = 0;
  private transitioning = false;
  private transitionFailed = false;
  constructor(
    public disk: Disk,
    public switched: () => void,
    public changed: () => void,
  ) {
    this.client = this.newClient();
  }
  private newClient() {
    const disk = this.disk,
      epoch = this.authEpoch;
    const diskStorage = {
      getItem: (k: string) =>
        epoch === this.authEpoch ? disk.read("auth", {})[k] || null : null,
      setItem: (k: string, v: string) => {
        if (epoch !== this.authEpoch) return;
        const a = disk.read("auth", {});
        a[k] = v;
        disk.write("auth", a);
      },
      removeItem: (k: string) => {
        if (epoch !== this.authEpoch) return;
        const a = disk.read("auth", {});
        delete a[k];
        disk.write("auth", a);
      },
    };
    return createClient(
      CLOUD_URL || "https://example.invalid",
      CLOUD_KEY || "not-configured",
      {
        global: {
          fetch: (url, init: any = {}) =>
            fetch(url, {
              ...init,
              signal: init.signal
                ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)])
                : AbortSignal.timeout(15000),
            }),
        },
        auth: {
          storage: diskStorage,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      },
    );
  }
  private get matchingScope() {
    return (
      typeof this.identity?.id === "string" &&
      this.identity.id.toLowerCase() === this.disk.scope.toLowerCase()
    );
  }
  get ready() {
    return (
      this.matchingScope &&
      !!this.settings &&
      !this.transitioning &&
      !this.transitionFailed
    );
  }
  async boot() {
    if (!CLOUD_CONFIGURED) {
      this.message =
        "Account services are not configured in this build. Guest use remains available.";
      this.changed();
      return;
    }
    this.transitioning = true;
    const epoch = ++this.epoch;
    try {
      const cached = this.disk.read("account", null);
      if (cached?.identity) {
        const staged = this.disk.prepareSwitch(cached.identity.id);
        this.disk.commitSwitch(staged);
        this.identity = cached.identity;
        this.settings = cached.settings;
        this.key = cached.key ? Buffer.from(cached.key, "base64") : undefined;
        this.switched();
      }
      const { data, error } = await this.client.auth.getUser();
      if (epoch !== this.epoch) return;
      if (error || !data.user) {
        this.message =
          "Account is offline. Your saved library remains available.";
        return;
      }
      if (this.identity?.id !== data.user.id) {
        const staged = this.disk.prepareSwitch(data.user.id);
        this.disk.commitSwitch(staged);
        this.identity = { id: data.user.id, email: data.user.email };
        this.key = undefined;
        this.settings = undefined;
        this.switched();
      }
      const settings = await this.fetchSettings();
      if (epoch !== this.epoch) return;
      if (
        this.settings &&
        settings?.generation.toUpperCase() !==
          this.settings.generation.toUpperCase()
      )
        this.key = undefined;
      this.settings = settings;
      this.cache();
      this.transitionFailed = false;
    } catch {
      if (epoch === this.epoch) {
        this.transitionFailed = true;
        this.message =
          "Account could not be restored. Your saved library is kept. Retry signing in after checking local storage.";
      }
    } finally {
      if (epoch === this.epoch) {
        this.transitioning = false;
        this.changed();
      }
    }
    if (epoch === this.epoch && this.ready) {
      await this.migrateLocalSources();
      void this.sync();
    }
  }
  cache() {
    this.disk.write(
      "account",
      this.identity
        ? {
            identity: this.identity,
            settings: this.settings,
            key: this.key?.toString("base64"),
          }
        : null,
    );
  }
  async fetchSettings(userID = this.identity?.id) {
    const { data, error } = await this.client
      .from("vault_settings")
      .select("*")
      .eq("user_id", userID)
      .maybeSingle();
    if (error) throw Error("Could not load encrypted account settings.");
    return data;
  }
  async auth(action: string, args: any) {
    if (!CLOUD_CONFIGURED)
      throw Error(
        "Account services are not configured in this build. You can continue as a guest.",
      );
    const email = String(args.email || "").trim(),
      password = String(args.password || "");
    if (email.length > 254 || password.length > 1024)
      throw Error("Invalid account details.");
    if (["signin", "verify", "reset"].includes(action))
      this.disk.flushPending();
    if (action === "signup") {
      if (password.length < 10) throw Error("Use at least 10 characters.");
      const { error } = await this.client.auth.signUp({ email, password });
      if (error) throw Error(error.message);
      return {
        verification: true,
        message: "Check your email for the registration code.",
      };
    }
    if (action === "resend") {
      const { error } = await this.client.auth.resend({
        type: "signup",
        email,
      });
      if (error) throw Error(error.message);
      return { message: "A new code was requested." };
    }
    if (action === "forgot") {
      const { error } = await this.client.auth.resetPasswordForEmail(email);
      if (error) throw Error(error.message);
      return {
        recovery: true,
        message: "If this account exists, a recovery code was sent.",
      };
    }
    if (action === "verify") {
      const { data, error } = await this.client.auth.verifyOtp({
        email,
        token: String(args.code || "").trim(),
        type: args.recovery ? "recovery" : "signup",
      });
      if (error) throw Error(error.message);
      if (args.recovery) {
        this.recovery = true;
        return {
          reset: true,
          message: "Code verified. Set your new password.",
        };
      }
      return this.attach(data.user, password, !!args.includeGuest);
    }
    if (action === "signin") {
      const { data, error } = await this.client.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw Error(error.message);
      return this.attach(data.user, password, !!args.includeGuest);
    }
    if (action === "unlock") {
      if (!this.identity) throw Error("Sign in first.");
      this.settings = await this.fetchSettings();
      this.key = await unlockVault(this.settings, password);
      this.cache();
      await this.sync();
      return { message: "Encrypted connections unlocked." };
    }
    if (action === "reset") {
      if (!this.recovery) throw Error("Verify a recovery code first.");
      if (password.length < 10) throw Error("Use at least 10 characters.");
      const {
        data: { user },
      } = await this.client.auth.getUser();
      if (!user) throw Error("Recovery session expired.");
      const { error } = await this.client.auth.updateUser({ password });
      if (error) throw Error(error.message);
      this.recovery = false;
      return this.attach(user, password, false);
    }
    if (action === "password") {
      if (!this.identity) throw Error("Sign in first.");
      if (password.length < 10) throw Error("Use at least 10 characters.");
      const { error } = await this.client.auth.updateUser({ password });
      if (error) throw Error(error.message);
      return {
        message: "Password changed. Your library and connections are kept.",
      };
    }
    throw Error("Unsupported account operation.");
  }
  async finishWrap(password?: string) {
    const replacement = this.disk.read("pending-wrap", null);
    if (!replacement || replacement.user_id !== this.identity?.id) return;
    if (password != null) {
      try {
        await unlockVault(replacement, password);
      } catch {
        const current = await this.fetchSettings();
        if (current) await unlockVault(current, password);
        this.disk.write("pending-wrap", null);
        return;
      }
    }
    const { data, error } = await this.client
      .from("vault_settings")
      .update(replacement)
      .eq("user_id", this.identity.id)
      .eq("generation", replacement.generation)
      .select();
    if (error || data?.length !== 1)
      throw Error(
        "Password changed; encrypted settings update needs to be retried when online.",
      );
    this.settings = replacement;
    this.cache();
    this.disk.write("pending-wrap", null);
  }
  async attach(user: any, password: string, includeGuest = false) {
    if (!user) throw Error("Sign-in did not return an account.");
    const epoch = ++this.epoch;
    this.transitioning = true;
    try {
      // A corrupt target vault or an unsaved outgoing library must not change
      // identity, keys, capabilities or account ownership.
      const staged = this.disk.prepareSwitch(user.id);
      const guest =
        this.disk.scope === "guest" ? structuredClone(this.disk.state) : null;
      const identity = { id: user.id, email: user.email };
      let settings = await this.fetchSettings(user.id);
      if (epoch !== this.epoch)
        throw Error("The account changed. Sign in again.");
      if (!settings) {
        const fresh = await createVault(user.id, uuid());
        const { error } = await this.client
          .from("vault_settings")
          .insert(fresh.settings);
        if (epoch !== this.epoch)
          throw Error("The account changed. Sign in again.");
        if (error) {
          settings = await this.fetchSettings(user.id);
          if (!settings) throw Error("Could not initialize account sync.");
        } else settings = fresh.settings;
      }
      const cached = this.disk.read("account", null);
      let key: Buffer;
      if (
        cached?.identity?.id === user.id &&
        cached?.settings?.generation === settings.generation &&
        cached.key
      )
        key = Buffer.from(cached.key, "base64");
      if (!key) {
        try {
          key = await unlockVault(settings, password);
        } catch {
          /* Old encrypted records remain intact. */
        }
      }
      if (epoch !== this.epoch)
        throw Error("The account changed. Sign in again.");
      this.disk.flushPending();
      // Finish all fallible I/O before committing the in-memory identity/scope.
      this.disk.write("pending-recovery", null);
      this.disk.write("pending-wrap", null);
      this.disk.write("account", {
        identity,
        settings,
        key: key?.toString("base64"),
      });
      this.disk.commitSwitch(staged);
      this.identity = identity;
      this.settings = settings;
      this.key = key;
      this.transitionFailed = false;
      this.transitioning = false;
      this.switched();
      await this.migrateLocalSources();
      await this.sync();
      if (epoch !== this.epoch) return { message: "Account changed." };
      if (includeGuest && guest) {
        for (const source of guest.sources)
          if (!this.disk.state.sources.some((x) => x.id === source.id)) {
            this.disk.state.sources.push(source);
            this.disk.state.credentials[source.id] =
              guest.credentials[source.id];
            this.source(source);
          }
        for (const m of guest.media) {
          if (!this.disk.state.media.some((x) => x.id === m.id))
            this.disk.state.media.push(m);
          if (guest.progress[m.id]) {
            this.disk.state.progress[m.id] = guest.progress[m.id];
            this.progress(m);
          }
          if (guest.favorites.includes(m.id)) {
            if (!this.disk.state.favorites.includes(m.id))
              this.disk.state.favorites.push(m.id);
            this.watchlist(m, true);
          }
        }
        this.disk.save();
        await this.sync();
      }
      this.changed();
      return { message: "Signed in. Your library is available." };
    } catch (error) {
      if (epoch === this.epoch) {
        this.transitionFailed = true;
        this.message =
          "Sign-in could not complete. Your saved library is kept and sync is paused. Check local storage and sign in again.";
        this.changed();
      }
      throw error;
    } finally {
      if (epoch === this.epoch) this.transitioning = false;
    }
  }
  async migrateLocalSources() {
    if (!this.ready || this.disk.state.accountFormat === 2) return;
    this.disk.state.journal.cursor = 0;
    for (const source of this.disk.state.sources) this.source(source);
    this.disk.state.accountFormat = 2;
    this.disk.save();
  }
  async signout() {
    // Preflight disk errors before revoking auth or clearing current identity.
    const staged = this.disk.prepareSwitch("guest");
    const epoch = ++this.epoch;
    this.transitioning = true;
    clearTimeout(this.timer);
    try {
      try {
        await this.client.auth.signOut({ scope: "local" });
      } catch {
        /* Local sign-out also works while offline. */
      }
      if (epoch !== this.epoch)
        throw Error("The account changed. Retry signing out.");
      this.disk.flushPending();
      this.client.auth.stopAutoRefresh?.();
      this.authEpoch++;
      this.disk.write("auth", {});
      this.disk.write("account", null);
      const nextClient = this.newClient();
      this.disk.commitSwitch(staged);
      this.client = nextClient;
      this.identity = undefined;
      this.key = undefined;
      this.settings = undefined;
      this.transitionFailed = false;
      this.transitioning = false;
      this.switched();
      this.changed();
    } catch (error) {
      if (epoch === this.epoch) {
        this.transitionFailed = true;
        this.message =
          "Sign-out could not complete. Your saved library is kept. Check local storage and retry.";
        this.changed();
      }
      throw error;
    } finally {
      if (epoch === this.epoch) this.transitioning = false;
    }
  }
  async deleteAccount(password: string) {
    if (!this.identity) throw Error("Sign in first.");
    const { error } = await this.client.auth.signInWithPassword({
      email: this.identity.email,
      password,
    });
    if (error) throw Error("Re-enter your current password.");
    const result = await this.client.functions.invoke("delete-account", {
      method: "DELETE",
      body: {},
    });
    if (result.error) throw Error("Account deletion failed. Please retry.");
    await this.signout();
  }
  queue(
    kind: string,
    key: string,
    value: any,
    deleted = false,
    encrypted = false,
  ) {
    if (!this.ready) return;
    const j = this.disk.state.journal,
      id = kind + ":" + key;
    const payload = Buffer.from(JSON.stringify(value)).toString("base64");
    j.pending[id] = {
      kind,
      key,
      payload: {
        value: payload,
        ...(kind === "source" ? { format: "account-v2" } : {}),
      },
      deleted,
      base_revision: j.revisions[id] || 0,
      mutationID: uuid(),
    };
    if (kind === "progress" && this.disk.saveSoon) this.disk.saveSoon();
    else this.disk.save();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync(), 750);
  }
  source(s: Source, deleted = false) {
    this.queue(
      "source",
      s.id,
      { source: s, credentials: this.disk.state.credentials[s.id] },
      deleted,
      true,
    );
  }
  progress(m: Media) {
    this.queue("progress", cloudKey(m), {
      media: cloudMedia(m),
      progress: this.disk.state.progress[m.id],
    });
  }
  watchlist(m: Media, present: boolean) {
    this.queue("watchlist", cloudKey(m), { media: cloudMedia(m) }, !present);
  }
  preferences() {
    const p = this.disk.state.preferences;
    this.queue("preferences", "playback", {
      audio: p.audioLanguage,
      subtitle: p.subtitleLanguage,
      autoplay: String(p.autoplay),
    });
  }
  apply(record: any) {
    const state = this.disk.state,
      value = record.payload?.value;
    if (record.kind === "source") {
      const id = record.key.toUpperCase();
      if (record.deleted) {
        state.sources = state.sources.filter((s) => s.id.toUpperCase() !== id);
        delete state.credentials[id];
        state.media = state.media.filter(
          (m) => m.sourceID.toUpperCase() !== id,
        );
        return;
      }
      let remote: any;
      if (record.payload.format === "account-v2")
        remote = JSON.parse(Buffer.from(value, "base64").toString());
      else {
        if (!this.key) {
          this.message =
            "Some older sources need a one-time transfer from a device that already has them. Your saved data is kept.";
          return;
        }
        remote = JSON.parse(
          open(
            value,
            this.key,
            this.identity.id,
            `source:${this.settings.generation.toUpperCase()}:${record.key}`,
          ).toString(),
        );
        // Queue the readable legacy record back in the new account-sync format.
        this.queue("source", record.key, remote);
      }
      if (
        remote.source.id.toUpperCase() !== id ||
        !/^[0-9a-f-]{36}$/i.test(id) ||
        !kinds.includes(remote.source.kind)
      )
        throw Error("Invalid encrypted source identity.");
      remote.source.allowHTTP = remote.source.allowHTTP === true;
      remote.source.allowProviderFetch =
        remote.source.allowProviderFetch === true;
      remote.source.allowInsecureStreams =
        remote.source.allowInsecureStreams === true;
      const endpoint = urlCheck(
        remote.credentials.endpoint,
        remote.source,
        remote.source.kind === "Video URL",
      );
      remote.source.id = id;
      remote.source.host = endpoint.host;
      remote.source.name = String(remote.source.name || "Source").slice(0, 160);
      state.sources = state.sources.filter((s) => s.id.toUpperCase() !== id);
      state.sources.push(remote.source);
      state.credentials[id] = remote.credentials;
    } else if (record.kind === "preferences" && !record.deleted) {
      const p = JSON.parse(Buffer.from(value, "base64").toString());
      if (["en", "de"].includes(p.audio))
        state.preferences.audioLanguage = p.audio;
      if (["en", "de", "off"].includes(p.subtitle))
        state.preferences.subtitleLanguage = p.subtitle;
      state.preferences.autoplay = p.autoplay === "true";
    } else if (["progress", "watchlist"].includes(record.kind) && value) {
      const remote = JSON.parse(Buffer.from(value, "base64").toString());
      remote.media = cloudInput(remote.media);
      if (cloudKey(remote.media) !== record.key) return;
      const target =
        state.media.find((m) => cloudKey(m) === record.key) || remote.media;
      if (!state.media.some((m) => m.id === target.id))
        state.media.push(target);
      if (record.kind === "progress") {
        if (record.deleted) delete state.progress[target.id];
        else if (remote.progress)
          state.progress[target.id] = {
            seconds: bounded(remote.progress.seconds),
            duration: bounded(remote.progress.duration),
            completed: remote.progress.completed === true,
            playedAt: Number.isFinite(remote.progress.playedAt)
              ? Math.max(
                  0,
                  Math.min(appleNow() + 86400, remote.progress.playedAt),
                )
              : appleNow(),
          };
      } else {
        state.favorites = state.favorites.filter((id) => id !== target.id);
        if (!record.deleted) state.favorites.push(target.id);
      }
    }
  }
  async sync() {
    if (this.syncing || !this.ready) return;
    const journal = this.disk.state.journal,
      generation = this.settings.generation.toUpperCase();
    if (journal.generation && journal.generation !== generation) {
      journal.pending = Object.fromEntries(
        Object.entries(journal.pending).filter(
          ([, change]: any) => change.kind !== "source",
        ),
      );
      journal.cursor = 0;
    }
    journal.generation = generation;
    this.disk.save();
    this.syncing = true;
    this.changed();
    const epoch = this.epoch,
      scope = this.disk.scope;
    try {
      for (let pass = 0; pass < 20; pass++) {
        const j = this.disk.state.journal,
          batch: any[] = Object.values(j.pending).slice(0, 200);
        let cursor = j.cursor,
          send = batch,
          rows: any[] = [],
          repulled = false,
          conflicts: any[] = [];
        for (let page = 0; page < 100; page++) {
          const { data, error } = await this.client.rpc("sync_library", {
            changes: send.map(({ mutationID, ...x }: any) => x),
            after_revision: cursor,
            expected_generation: this.settings.generation,
          });
          if (epoch !== this.epoch || scope !== this.disk.scope || !this.ready)
            return;
          if (error) throw error;
          if (
            data.generation.toUpperCase() !==
            this.settings.generation.toUpperCase()
          ) {
            this.key = undefined;
            throw Error("Vault generation changed.");
          }
          conflicts.push(...data.conflicts);
          if (data.conflicts.length && !repulled) {
            repulled = true;
            cursor = 0;
            send = [];
            continue;
          }
          rows.push(...data.records);
          cursor = Math.max(
            cursor,
            ...data.records.map((r: any) => r.revision),
          );
          send = [];
          if (data.records.length < 1000) break;
        }
        const sent = new Map(
          batch.map((c) => [c.kind + ":" + c.key, c.mutationID]),
        );
        for (const r of rows) {
          const id = r.kind + ":" + r.key,
            pending = j.pending[id];
          j.revisions[id] = r.revision;
          if (pending && pending.mutationID !== sent.get(id)) {
            pending.base_revision = r.revision;
            continue;
          }
          this.apply(r);
        }
        for (const c of batch) {
          const id = c.kind + ":" + c.key;
          if (j.pending[id]?.mutationID === c.mutationID) delete j.pending[id];
        }
        j.cursor = cursor;
        this.disk.save();
        this.message = conflicts.length
          ? "A newer edit from another device was kept."
          : "";
        this.lastSync = appleNow();
        if (!Object.keys(j.pending).length) break;
      }
    } catch (e: any) {
      if (epoch === this.epoch) {
        if (String(e.message).includes("generation")) {
          this.key = undefined;
          this.cache();
          this.message =
            "Account settings changed. Sign in again to resume sync.";
        } else
          this.message =
            "Could not sync. Local edits are saved and will retry.";
      }
    } finally {
      this.syncing = false;
      this.changed();
    }
  }
}
