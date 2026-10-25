import { Module } from "@nestjs/common";
import { OcrProviders } from "./ocr-providers";
import { ReceiptsController } from "./receipts.controller";
import { ReceiptsService } from "./receipts.service";

/** Receipt OCR (/api/v2/receipts): scan → review → attach to an expenses claim. */
@Module({
  controllers: [ReceiptsController],
  providers: [ReceiptsService, OcrProviders],
})
export class ReceiptsModule {}
