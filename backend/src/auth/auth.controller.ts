
import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { z } from 'zod';
import { Auth, Public, Roles } from '../common/decorators';
import { Errors } from '../common/errors';
import { cleanText } from '../common/schemas';
import type { AuthContext } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { env } from '../config/env';
import { AuthService } from './auth.service';

const teacherLoginSchema = z.object({
  name: cleanText(120),
  passcode: z
    .string()
    .max(128)
    .optional()
    .transform((v) => (v ? v : undefined)),
});
type TeacherLoginDto = z.infer<typeof teacherLoginSchema>;

const studentLoginSchema = z.object({ studentId: z.string().trim().min(1, 'Student ID is required').max(40) });
type StudentLoginDto = z.infer<typeof studentLoginSchema>;

const cookieOptions = (): CookieOptions => ({
  httpOnly: true, // not readable by page scripts, so XSS cannot steal the session
  secure: env.cookieSecure,
  sameSite: env.isProduction ? 'none' : 'lax',
  path: '/',
});

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('teacher/login')
  @HttpCode(200)
  async teacherLogin(
    @Body(new ZodPipe(teacherLoginSchema)) dto: TeacherLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { sid, session } = await this.auth.teacherLogin(dto.name, dto.passcode, req.ip ?? 'unknown', this.currentSid(req));
    res.cookie(env.SESSION_COOKIE_NAME, sid, cookieOptions());
    return session;
  }

  @Public()
  @Post('student/login')
  @HttpCode(200)
  async studentLogin(
    @Body(new ZodPipe(studentLoginSchema)) dto: StudentLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { sid, session } = await this.auth.studentLogin(dto.studentId, req.ip ?? 'unknown', this.currentSid(req));
    res.cookie(env.SESSION_COOKIE_NAME, sid, cookieOptions());
    return session;
  }

  @Get('me')
  @Roles('teacher', 'student')
  async me(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const session = await this.auth.describe(auth.role, auth.userId, auth.csrfToken);
    if (!session) {
      await this.auth.logout(auth.sessionId);
      res.clearCookie(env.SESSION_COOKIE_NAME, cookieOptions());
      throw Errors.unauthenticated();
    }
    return session;
  }

  @Post('logout')
  @Roles('teacher', 'student')
  @HttpCode(204)
  async logout(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(auth.sessionId);
    res.clearCookie(env.SESSION_COOKIE_NAME, cookieOptions());
  }

  private currentSid(req: Request): string | undefined {
    const sid = req.cookies?.[env.SESSION_COOKIE_NAME];
    return typeof sid === 'string' && sid ? sid : undefined;
  }
}
