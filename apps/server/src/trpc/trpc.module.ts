import { Module } from '@nestjs/common';
import { TrpcService } from '@server/trpc/trpc.service';
import { TrpcRouter } from '@server/trpc/trpc.router';
import { PrismaModule } from '@server/prisma/prisma.module';
import { FeishuLoginService } from '@server/trpc/feishu-login.service';

@Module({
  imports: [PrismaModule],
  controllers: [],
  providers: [TrpcService, TrpcRouter, FeishuLoginService],
  exports: [TrpcService, TrpcRouter],
})
export class TrpcModule {}
