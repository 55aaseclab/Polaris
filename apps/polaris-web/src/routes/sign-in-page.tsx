import { useAuth } from "@clerk/react";
import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { portalSignInUrl } from "@/lib/portal-auth";

export default function SignInPage() {
  const { isLoaded, userId } = useAuth();
  useEffect(() => {
    if (isLoaded && userId) {
      return;
    }
    window.location.assign(portalSignInUrl());
  }, [isLoaded, userId]);
  if (isLoaded && userId) {
    return <Navigate to="/" replace />;
  }
  return null;
}
