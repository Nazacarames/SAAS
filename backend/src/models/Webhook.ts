import {
    Table,
    Column,
    CreatedAt,
    UpdatedAt,
    Model,
    PrimaryKey,
    AutoIncrement,
    AllowNull,
    Default
} from "sequelize-typescript";

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

    @CreatedAt
    createdAt: Date;

    @UpdatedAt
    updatedAt: Date;
}

export default Webhook;
