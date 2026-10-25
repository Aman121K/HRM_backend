import { Module } from "@nestjs/common";
import { AccountAccessService } from "./account-access.service";
import { AuthMailer } from "./auth-mailer";
import { AccountAccessController, JwksController, NativeAuthController, PlatformAuthController } from "./native-auth.controller";
import { NativeAuthService } from "./native-auth.service";

/** First-party sign-in: passwords, TOTP MFA, rotating refresh sessions, invites, reset, brand sign-in policy. */
@Module({
  controllers: [NativeAuthController, JwksController, AccountAccessController, PlatformAuthController],
  providers: [NativeAuthService, AccountAccessService, AuthMailer],
  exports: [NativeAuthService],
})
export class NativeAuthModule {}
