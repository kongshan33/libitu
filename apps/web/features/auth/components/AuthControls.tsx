"use client";

import { currentAuthReturnUrl } from "@/features/navigation/return-location";

import { Button, ButtonLink } from "@/components/ui/button";

import { Show, UserButton, useClerk } from "@clerk/nextjs";

export function AuthControls({ showProfileLink = true, buttonSize = "inherit" }: { showProfileLink?: boolean; buttonSize?: "sm" | "inherit" } = {}) {
  const clerk = useClerk();

  function signIn() {
    const returnUrl = currentAuthReturnUrl();
    clerk.openSignIn({ forceRedirectUrl: returnUrl, signUpForceRedirectUrl: returnUrl });
  }

  function signUp() {
    const returnUrl = currentAuthReturnUrl();
    clerk.openSignUp({ forceRedirectUrl: returnUrl, signInForceRedirectUrl: returnUrl });
  }

  return (
    <div className="auth-controls" aria-label="Account">
      <Show when="signed-out">
        <Button variant="secondary" size={buttonSize} className="auth-button" type="button" onClick={signIn}>Sign in</Button>
        <Button variant="primary" size={buttonSize} className="auth-button primary" type="button" onClick={signUp}>Create account</Button>
      </Show>
      <Show when="signed-in">
        {showProfileLink ? <ButtonLink variant="secondary" size={buttonSize} className="auth-button" style={{ textDecoration: "none" }} href="/profile">My learning</ButtonLink> : null}
        <UserButton />
      </Show>
    </div>
  );
}
