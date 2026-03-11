import {
    Table,
    Column,
    CreatedAt,
    UpdatedAt,
    Model,
    PrimaryKey,
    AutoIncrement,
    AllowNull,
    Default,
    ForeignKey,
    BelongsTo,
    HasMany
} from "sequelize-typescript";
import Company from "./Company";

@Table({ tableName: "queues" })
class Queue extends Model {
    @PrimaryKey
    @AutoIncrement
    @Column
    id: number;

    @AllowNull(false)
    @Column
    name: string;

    @Default("#3b82f6")
    @Column
    color: string;

    @Default("")
    @Column
    greetingMessage: string;

    @ForeignKey(() => Company)
    @AllowNull(false)
    @Column
    companyId: number;

    @BelongsTo(() => Company)
    company: Company;

    @CreatedAt
    createdAt: Date;

    @UpdatedAt
    updatedAt: Date;
}

export default Queue;
