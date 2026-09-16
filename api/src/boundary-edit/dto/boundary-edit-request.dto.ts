import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsNotEmpty, IsString, Min, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class GeoJsonPolygonDto {
  @ApiProperty({ enum: ['Polygon'] })
  @IsIn(['Polygon'])
  type!: 'Polygon';

  @ApiProperty({
    description:
      'GeoJSON Polygon coordinates (array of linear rings of [x, y] pairs), in the parcel table\'s native ' +
      'CRS (EPSG:32736), not WGS84',
    type: 'array',
    items: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
  })
  @IsArray()
  coordinates!: number[][][];
}

export class BoundaryEditRequestDto {
  @ApiProperty({ example: '1/1/1/1500', description: 'UPI of the parcel to correct' })
  @IsString()
  @IsNotEmpty()
  upi!: string;

  @ApiProperty({ example: 'EDIT-0001' })
  @IsString()
  @IsNotEmpty()
  case_reference!: string;

  @ApiProperty({ example: 'officer-a' })
  @IsString()
  @IsNotEmpty()
  officer_id!: string;

  @ApiProperty({
    example: 1,
    description:
      'The parcel\'s `version` as last read by this officer (see GET /parcels/{upi}) -- the optimistic-' +
      'concurrency token. A mismatch against the parcel\'s current version is rejected as stale_version.',
  })
  @IsInt()
  @Min(1)
  base_version!: number;

  @ApiProperty({ type: GeoJsonPolygonDto })
  @ValidateNested()
  @Type(() => GeoJsonPolygonDto)
  new_geometry!: GeoJsonPolygonDto;
}
