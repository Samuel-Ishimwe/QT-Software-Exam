import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsNotEmpty, IsString, Min, ValidateNested } from 'class-validator';

export class GeoJsonPolygonDto {
  @IsIn(['Polygon'])
  type!: 'Polygon';

  @IsArray()
  coordinates!: number[][][];
}

export class BoundaryEditRequestDto {
  @IsString()
  @IsNotEmpty()
  upi!: string;

  @IsString()
  @IsNotEmpty()
  case_reference!: string;

  @IsString()
  @IsNotEmpty()
  officer_id!: string;

  /** The parcel's `version` as last read by this officer -- the optimistic-concurrency token. */
  @IsInt()
  @Min(1)
  base_version!: number;

  @ValidateNested()
  @Type(() => GeoJsonPolygonDto)
  new_geometry!: GeoJsonPolygonDto;
}
