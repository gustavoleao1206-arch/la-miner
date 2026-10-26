import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { VersaoController } from './versao.controller';

@Module({ controllers: [HealthController, VersaoController] })
export class HealthModule {}
