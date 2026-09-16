import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsIn, IsNotEmpty, IsString, ValidateNested } from 'class-validator';
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
    example: [
      [
        [500000.0, 9780000.0],
        [500013.5, 9780000.0],
        [500013.5, 9780030.0],
        [500000.0, 9780030.0],
        [500000.0, 9780000.0],
      ],
    ],
  })
  @IsArray()
  coordinates!: number[][][];
}

export class SubdivisionRequestDto {
  @ApiProperty({ example: '1/1/1/1000' })
  @IsString()
  @IsNotEmpty()
  parent_upi!: string;

  @ApiProperty({ example: 'DEMO-0001' })
  @IsString()
  @IsNotEmpty()
  case_reference!: string;

  @ApiProperty({ example: 'demo-officer' })
  @IsString()
  @IsNotEmpty()
  officer_id!: string;

  @ApiProperty({ type: [GeoJsonPolygonDto], minItems: 2 })
  @IsArray()
  @ArrayMinSize(2, { message: 'a subdivision must produce at least 2 child parcels' })
  @ValidateNested({ each: true })
  @Type(() => GeoJsonPolygonDto)
  child_geometries!: GeoJsonPolygonDto[];
}
