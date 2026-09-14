import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsNotEmpty, IsString, ValidateNested } from 'class-validator';

export class GeoJsonPolygonDto {
  @IsIn(['Polygon'])
  type!: 'Polygon';

  @IsArray()
  coordinates!: number[][][];
}

export class SubdivisionRequestDto {
  @IsString()
  @IsNotEmpty()
  parent_upi!: string;

  @IsString()
  @IsNotEmpty()
  case_reference!: string;

  @IsString()
  @IsNotEmpty()
  officer_id!: string;

  @IsArray()
  @ArrayMinSize(2, { message: 'a subdivision must produce at least 2 child parcels' })
  @ValidateNested({ each: true })
  @Type(() => GeoJsonPolygonDto)
  child_geometries!: GeoJsonPolygonDto[];
}
