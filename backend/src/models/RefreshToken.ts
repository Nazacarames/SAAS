import {
    Table,
    Column,
    CreatedAt,
    Model,
    PrimaryKey,
    AutoIncrement,
    AllowNull,
    ForeignKey,
    BelongsTo,
    Default,
    DataType
} from "sequelize-typescript";
import User from "./User";

@Table({ tableName: "refresh_tokens", updatedAt: false })
class RefreshToken extends Model {
    @PrimaryKey
    @AutoIncrement
    @Column
    id: number;

    @AllowNull(false)
    @Column(DataType.TEXT)
    token: string;

    @ForeignKey(() => User)
    @AllowNull(false)
    @Column
    userId: number;

    @BelongsTo(() => User)
    user: User;

    @AllowNull(false)
    @Column
    expiresAt: Date;

    @Default(false)
    @Column
    revoked: boolean;

    @CreatedAt
    createdAt: Date;
}

export default RefreshToken;
