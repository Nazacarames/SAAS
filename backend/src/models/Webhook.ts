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
    BelongsTo
} from "sequelize-typescript";
import Company from "./Company";

@Table({ tableName: "webhooks" })
class Webhook extends Model {
    @PrimaryKey
    @AutoIncrement
    @Column
    id: number;

    @AllowNull(false)
    @Column
    name: string;

    @AllowNull(false)
    @Column
    url: string;

    @AllowNull(false)
    @Default("message.create")
    @Column
    event: string;

    @Default(true)
    @Column
    active: boolean;

    @Column
    description: string;

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

export default Webhook;
