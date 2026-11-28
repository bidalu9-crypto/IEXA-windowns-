/**
 * Optional LAN listener. Never expose the desktop HTTP listener on 0.0.0.0.
 *
 * Certificates are split into a long-lived root CA and a short-lived leaf.
 * The phone installs the CA once; a renumber then only re-signs the leaf, which
 * needs no new trust decision. Before this split every prefix change forced a
 * fresh install on the phone, which is exactly why the bridge kept breaking.
 */
export declare class MobileTlsListener {
    private readonly workspace;
    private readonly handler;
    private server;
    private redirect;
    private starting;
    private watcher;
    private addresses;
    constructor(workspace: string, handler: import('http').RequestListener);
    /** Addresses currently covered by the served certificate. */
    currentAddresses(): string[];
    start(): Promise<number>;
    /** Plain http://<lan-ip>/ must land on https, otherwise a phone typing the bare IP fails. */
    private listenRedirect;
    /**
     * Load or create the root CA.
     *
     * A certificate issued by an earlier version of this file is adopted as the
     * CA when it carries cA:true, so a phone that already trusted that install
     * keeps working instead of demanding another round of manual trust.
     */
    private ensureCa;
    /** Re-sign the leaf whenever the address set drifts or it is close to expiry. */
    private ensureLeaf;
    /**
     * Re-check the interface addresses and hot-swap the leaf when they change.
     *
     * setSecureContext() replaces the keypair without closing the listener, so an
     * in-flight phone request is not dropped and no restart is needed mid-session.
     */
    private watch;
    private open;
    stop(): Promise<void>;
}
//# sourceMappingURL=MobileTlsListener.d.ts.map