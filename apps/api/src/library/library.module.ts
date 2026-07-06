import { Module } from '@nestjs/common';
import { DrizzleModule } from '../infra/drizzle.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SpacesModule } from '../spaces/spaces.module.js';
import { LibraryController } from './library.controller.js';
import { LibraryStore } from './library.store.js';

/** 자료실(축4) — 집계 read 전용. SpacesModule에서 SpaceAccessService 주입. */
@Module({
  imports: [DrizzleModule, AuthModule, SpacesModule],
  controllers: [LibraryController],
  providers: [LibraryStore],
  exports: [LibraryStore],
})
export class LibraryModule {}
