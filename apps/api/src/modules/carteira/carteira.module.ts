import { Module } from '@nestjs/common';
import { CarteiraService } from './carteira.service';
import { CarteiraController } from './carteira.controller';

@Module({
  controllers: [CarteiraController],
  providers: [CarteiraService],
  exports: [CarteiraService],
})
export class CarteiraModule {}
